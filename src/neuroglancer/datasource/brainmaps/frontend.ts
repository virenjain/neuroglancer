/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import 'neuroglancer/datasource/brainmaps/api_frontend';

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {makeRequest, INSTANCE_NAMES, INSTANCE_IDENTIFIERS, PRODUCTION_INSTANCE, BrainmapsInstance} from 'neuroglancer/datasource/brainmaps/api';
import {VolumeChunkEncoding} from 'neuroglancer/datasource/brainmaps/base';
import {registerDataSourceFactory} from 'neuroglancer/datasource/factory';
import {DataType, VolumeType, VolumeChunkSpecification} from 'neuroglancer/sliceview/base';
import {VolumeChunkSource as GenericVolumeChunkSource, MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {getPrefixMatches} from 'neuroglancer/util/completion';
import {StatusMessage} from 'neuroglancer/status';
import {Vec3, vec3} from 'neuroglancer/util/geom';
import {verifyObject, verifyString, verifyPositiveInt, verifyMapKey, verifyFinitePositiveFloat, parseXYZ, parseArray, stableStringify} from 'neuroglancer/util/json';

const SERVER_DATA_TYPES = new Map<string, DataType>();
SERVER_DATA_TYPES.set('UINT8', DataType.UINT8);
SERVER_DATA_TYPES.set('FLOAT', DataType.FLOAT32);
SERVER_DATA_TYPES.set('UINT64', DataType.UINT64);

export class VolumeInfo {
  numChannels: number;
  dataType: DataType;
  voxelSize: Vec3;
  upperVoxelBound: Vec3;
  constructor(obj: any) {
    try {
      verifyObject(obj);
      this.numChannels = verifyPositiveInt(obj['channelCount']);
      this.dataType = verifyMapKey(obj['channelType'], SERVER_DATA_TYPES);
      this.voxelSize = parseXYZ(vec3.create(), obj['pixelSize'], verifyFinitePositiveFloat);
      this.upperVoxelBound = parseXYZ(vec3.create(), obj['volumeSize'], verifyPositiveInt);
    } catch (parseError) {
      throw new Error(`Failed to parse BrainMaps volume geometry: ${parseError.message}`);
    }
  }
};

export class VolumeChunkSource extends GenericVolumeChunkSource {
  constructor(
      chunkManager: ChunkManager, spec: VolumeChunkSpecification,
      public instance: BrainmapsInstance, public key: string, scaleIndex: number,
      public encoding: VolumeChunkEncoding) {
    super(chunkManager, spec);
    this.initializeCounterpart(chunkManager.rpc, {
      'type': 'brainmaps/VolumeChunkSource',
      'instance': instance,
      'key': key,
      'scaleIndex': scaleIndex,
      'encoding': encoding,
    });
  }

  toString() { return `brainmaps-${INSTANCE_IDENTIFIERS[this.instance]}:volume:${this.key}`; }
};

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  volumeType: VolumeType;
  scales: VolumeInfo[];
  dataType: DataType;
  numChannels: number;
  constructor(public instance: BrainmapsInstance, public key: string, obj: any) {
    try {
      verifyObject(obj);
      let scales = this.scales = parseArray(obj['geometry'], x => new VolumeInfo(x));
      if (scales.length === 0) {
        throw new Error('Expected at least one scale.');
      }
      let baseScale = scales[0];
      let numChannels = this.numChannels = baseScale.numChannels;
      let dataType = this.dataType = baseScale.dataType;
      for (let scaleIndex = 1, numScales = scales.length; scaleIndex < numScales; ++scaleIndex) {
        let scale = scales[scaleIndex];
        if (scale.dataType !== dataType) {
          throw new Error(
              `Scale ${scaleIndex} has data type ${DataType[scale.dataType]} but scale 0 has data type ${DataType[dataType]}.`);
        }
        if (scale.numChannels !== numChannels) {
          throw new Error(
              `Scale ${scaleIndex} has ${scale.numChannels} channel(s) but scale 0 has ${numChannels} channels.`);
        }
      }

      // Infer the VolumeType from the data type and number of channels.
      let volumeType = VolumeType.UNKNOWN;
      if (numChannels === 1) {
        switch (dataType) {
          case DataType.UINT64:
            volumeType = VolumeType.SEGMENTATION;
            break;
          case DataType.UINT8:
          case DataType.FLOAT32:
            volumeType = VolumeType.IMAGE;
            break;
        }
      }
      this.volumeType = volumeType;

    } catch (parseError) {
      throw new Error(`Failed to parse BrainMaps multiscale volume specification: ${parseError.message}`);
    }
  }

  getSources(chunkManager: ChunkManager) {
    let encoding = VolumeChunkEncoding.RAW;
    // if (this.volumeType === VolumeType.SEGMENTATION) {
    //   encoding = VolumeChunkEncoding.COMPRESSED_SEGMENTATION;
    // } else
    if (this.volumeType === VolumeType.IMAGE && this.dataType === DataType.UINT8) {
      encoding = VolumeChunkEncoding.JPEG;
    }

    return this.scales.map(
        (volumeInfo, scaleIndex) =>
            Array
                .from(VolumeChunkSpecification.getDefaults({
                  voxelSize: volumeInfo.voxelSize,
                  dataType: volumeInfo.dataType,
                  numChannels: volumeInfo.numChannels,
                  lowerVoxelBound: vec3.fromValues(0, 0, 0),
                  upperVoxelBound: volumeInfo.upperVoxelBound,
                  volumeType: this.volumeType,
                }))
                .map(spec => {

                  let cacheKey = stableStringify({
                    'instance': this.instance,
                    'key': this.key,
                    'scale': scaleIndex,
                    'encoding': encoding
                  });
                  return chunkManager.getChunkSource(
                      VolumeChunkSource, cacheKey,
                      () => new VolumeChunkSource(
                          chunkManager, spec, this.instance, this.key, scaleIndex, encoding));
                }));
  }

  /**
   * Meshes are not supported.
   */
  getMeshSource(chunkManager: ChunkManager): null { return null; }
};

let existingVolumes = new Map<string, Promise<MultiscaleVolumeChunkSource>>();

export function getVolume(instance: BrainmapsInstance, key: string) {
  let cacheKey = stableStringify({'instance': instance, 'key': key});
  let existingResult = existingVolumes.get(cacheKey);
  if (existingResult !== undefined) {
    return existingResult;
  }
  let promise =
    makeRequest(instance, 'GET', `/v1beta2/volumes/${key}`, 'json')
    .then(response => new MultiscaleVolumeChunkSource(instance, key, response));
  existingVolumes.set(cacheKey, promise);
  return promise;
}

export class VolumeList {
  volumeIds: string[];
  hierarchicalVolumeIds = new Map<string, string[]>();
  constructor (response: any) {
    try {
      verifyObject(response);
      let volumeIds = this.volumeIds = parseArray(response['volumeId'], verifyString);
      volumeIds.sort();
      let hierarchicalSets = new Map<string, Set<string>>();
      for (let volumeId of volumeIds) {
        let componentStart = 0;
        while (true) {
          let nextColon = volumeId.indexOf(':', componentStart);
          if (nextColon === -1) {
            nextColon = undefined;
          } else {
            ++nextColon;
          }
          let groupString = volumeId.substring(0, componentStart);
          let group = hierarchicalSets.get(groupString);
          if (group === undefined) {
            group = new Set<string>();
            hierarchicalSets.set(groupString, group);
          }
          group.add(volumeId.substring(componentStart, nextColon));
          if (nextColon === undefined) {
            break;
          }
          componentStart = nextColon;
        }
      }
      let {hierarchicalVolumeIds} = this;
      for (let [group, valueSet] of hierarchicalSets) {
        hierarchicalVolumeIds.set(group, Array.from(valueSet));
      }
    } catch (parseError) {
      throw new Error(`Failed to parse Brain Maps volume list reply: ${parseError.message}`);
    }
  }
};

let volumeListCache = new Map<BrainmapsInstance, Promise<VolumeList>>();

export function getVolumeList(instance: BrainmapsInstance) {
  let promise = volumeListCache.get(instance);
  if (promise === undefined) {
    promise = makeRequest(instance, 'GET', '/v1beta2/volumes/', 'json')
                  .then(response => new VolumeList(response));
    const description = `Google ${INSTANCE_NAMES[instance]} volume list`;
    StatusMessage.forPromise(promise, {
      delay: true,
      initialMessage: `Retrieving ${description}.`,
      errorPrefix: `Error retrieving ${description}: `,
    });
    volumeListCache.set(instance, promise);
  }
  return promise;
}

export function volumeCompleter(instance: BrainmapsInstance, url: string) {
  return getVolumeList(instance).then(volumeList => {
    let lastColon = url.lastIndexOf(':');
    let splitPoint = lastColon + 1;
    let prefix = url.substring(0, splitPoint);
    let matchString = url.substring(splitPoint);
    let possibleMatches = volumeList.hierarchicalVolumeIds.get(prefix);
    if (possibleMatches === undefined) {
      return null;
    }
    return {offset: prefix.length, completions: getPrefixMatches(matchString, possibleMatches)};
  });
}

export function registerBrainmapsDataSource(instance: BrainmapsInstance) {
  let protocol = 'brainmaps';
  if (instance !== PRODUCTION_INSTANCE) {
    protocol += `-${INSTANCE_IDENTIFIERS[instance].toLowerCase()}`;
  }
  registerDataSourceFactory(protocol, {
    description: `Google ${INSTANCE_NAMES[instance]} API`,
    getVolume: getVolume.bind(undefined, instance),
    volumeCompleter: volumeCompleter.bind(undefined, instance),
  });
}

registerBrainmapsDataSource(PRODUCTION_INSTANCE);
