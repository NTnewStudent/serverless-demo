/* eslint-disable prefer-const */
/* eslint-disable camelcase */
/* eslint-disable no-unneeded-ternary */
/* eslint-disable no-param-reassign */
/* eslint-disable no-restricted-syntax */
'use strict';

const CosSdk = require('cos-nodejs-sdk-v5');
const requestPromise = require('request-promise');
const request = require('request');
const Async = require('async');
const { inspect } = require('util');
const { URL } = require('url');
const { pipeline, PassThrough } = require('stream');
const requestPromiseRetry = retry({ func: requestPromise });

/**
 * parse common params from event and process.env
 */
function getCommonParams(event) {
  let body = event;
  try {
    if (event.body) {
      body = JSON.parse(event.body);
    }
  } catch (err) {
    throw new Error('request body is not a json string');
  }
  let {
    TENCENTCLOUD_SECRETID: secretId,
    TENCENTCLOUD_SECRETKEY: secretKey,
    TENCENTCLOUD_SESSIONTOKEN: token,
    Records: records,
    ObjectInfo: objectInfo,
    Upstream: upstream,
    sourceFrom = ['cosWorkflowObjectInfo'],
    sourceList = [],
    sourceConfigList = [],
    avoidLoopRisk,
    extraData = {},
    callbackUrl,
    parentRequestId,
    ...args
  } = {
    ...process.env,
    ...event,
    ...body,
  };

  try {
    if (typeof extraData === 'string') {
      extraData = JSON.parse(extraData);
    }
  } catch (err) {
    throw new Error('extraData must be JSON Object');
  }

  try {
    if (typeof sourceFrom === 'string') {
      sourceFrom = JSON.parse(sourceFrom);
    }
  } catch (err) {}

  try {
    if (typeof sourceFrom === 'string') {
      sourceFrom = [sourceFrom];
    }
  } catch (err) {}

  let triggerType = '';

  const missingParams = [
    { key: 'TENCENTCLOUD_SECRETID', value: secretId },
    { key: 'TENCENTCLOUD_SECRETKEY', value: secretKey },
    // { key: 'TENCENTCLOUD_SESSIONTOKEN', value: token },
  ]
    .filter(item => !item.value)
    .map(item => item.key);

  if (missingParams.length) {
    throw new Error(`params parsed error, missing params: ${missingParams.join(', ')}`);
  }

  if (parentRequestId) {
    logger({
      title: `this function is trigger by parent function, parent request id is ${parentRequestId}`,
    });
  }

  if (records) {
    logger({ title: 'this function is trigger by cos' });
    triggerType = 'cosTrigger';
    records
      .map(item => parseUrl(item.cos.cosObject.url))
      .forEach(item => sourceList.push(item));
    avoidLoopRisk = getFinalValue(avoidLoopRisk, 'true');
  } else if (objectInfo) {
    logger({ title: 'this function is trigger by cos workflow' });
    triggerType = 'cosWorkflow';
    const { BucketId: bucket, Region: region, Object: key } = objectInfo;
    const {
      BucketId: cosWorkflowUpstreamBucket,
      Region: cosWorkflowUpstreamRegion,
      Object: cosWorkflowUpstreamKey,
    } = upstream;
    if (sourceFrom.includes('cosWorkflowUpstream')) {
      sourceList.push({
        bucket: cosWorkflowUpstreamBucket,
        region: cosWorkflowUpstreamRegion,
        key: cosWorkflowUpstreamKey,
      });
    }
    if (sourceFrom.includes('cosWorkflowObjectInfo')) {
      sourceList.push({
        bucket,
        region,
        key,
      });
    }
    avoidLoopRisk = getFinalValue(avoidLoopRisk, 'true');
  } else {
    if (event.body) {
      logger({
        title: 'this function is trigger by apigateway',
      });
    } else {
      logger({
        title: 'this function is trigger by scf invoke',
      });
    }
    avoidLoopRisk = getFinalValue(avoidLoopRisk, 'false');
  }

  if (!sourceList.length && !sourceConfigList.length) {
    throw new Error('sourceList or sourceConfigList should be set');
  }

  return {
    secretId,
    secretKey,
    token,
    sourceList,
    sourceConfigList,
    triggerType,
    avoidLoopRisk: ['true', true].includes(avoidLoopRisk),
    extraData,
    callbackUrl,
    parentRequestId,
    ...args,
  };
}
/**
 * parse params from event and process.env
 */
function getParams(event, { function_name }) {
  const commonParams = getCommonParams(event);
  let {
    // add custom params here
  } = {
    ...process.env,
    ...event,
    ...commonParams,
  };

  return {
    ...commonParams,
    functionName: function_name,
  };
}
/**
 * return defaultValue when value is undefined or null
 */
function getFinalValue(value, defaultValue) {
  return value === undefined || value === null ? defaultValue : value;
}
/**
 * classify data by getClassifyId
 */
function getClassifyList({ list, getClassifyId }) {
  const classifyMap = {};
  for (const item of list) {
    const classifyId = getClassifyId(item);
    classifyMap[classifyId] = classifyMap[classifyId] || [];
    classifyMap[classifyId].push(item);
  }
  return Object.values(classifyMap);
}
/**
 * get a CosSdk Instance, add retry methods
 */
function getCosSdkInstance({ secretId, secretKey, token }) {
  const cosSdkInstance = new CosSdk({
    SecretId: secretId,
    SecretKey: secretKey,
    XCosSecurityToken: token,
  });
  const methods = Object.keys(CosSdk.prototype);
  const result = {};
  methods.forEach((method) => {
    if (method === 'getObjectUrl' || method.endsWith('Stream')) {
      result[method] = (...args) => cosSdkInstance[method](...args);
    } else {
      result[method] = retry({
        func: async (...args) => {
          let { Body = {}, GetBody } = args[0] || {};
          if (GetBody) {
            Body = GetBody();
            if (Body.then && typeof Body.then === 'function') {
              Body = await Body;
            }
            args[0].Body = Body;
          }
          try {
            const res = await cosSdkInstance[method](...args);
            return res;
          } catch (err) {
            throw err;
          }
        },
        maxTryTime: 3,
      });
    }
  });
  return result;
}
/**
 * parse url to get the key message
 */
function parseUrl(url) {
  const { host, pathname } = new URL(url);
  const { 1: bucket, 2: region } = host.match(/^([^.]*)\.cos\.([^.]*)\.myqcloud\.com$/);
  let key = decodeURIComponent(pathname.slice(1));
  if (key.includes('?')) {
    key = key.replace(/\?[\s\S]*$/, '');
  }
  return {
    bucket,
    region,
    key,
  };
}
/**
 * try to add signature on cos url
 */
function tryAddCosSignature({ cosSdkInstance, url }) {
  const { host, pathname, searchParams } = new URL(url);
  if (/^([^.]*)\.cos\.([^.]*)\.myqcloud\.com$/.test(host)) {
    // if url already has signature, return url
    if (searchParams.has('q-signature')) {
      return url;
    }
    const { 1: Bucket, 2: Region } = host.match(/^([^.]*)\.cos\.([^.]*)\.myqcloud\.com$/);
    const Key = decodeURIComponent(pathname.slice(1));
    return cosSdkInstance.getObjectUrl({
      Bucket,
      Region,
      Key,
      Sign: true,
      Expires: 24 * 60 * 60,
    });
  }
  return url;
}
/**
 * get meta headers from url
 */
async function getMetaFromUrl(url) {
  let meta;
  try {
    const { headers } = await requestPromiseRetry({
      uri: url,
      method: 'GET',
      headers: {
        range: 'bytes=0-0',
      },
      transform: (body, response) => response,
    });
    meta = headers;
  } catch (err) {
    if (err.statusCode !== 416) {
      throw err;
    }
    // if response http code is 416, assume that file size is 0
    const { headers } = await requestPromiseRetry({
      uri: url,
      method: 'GET',
      transform: (body, response) => response,
    });
    meta = headers;
  }
  meta['content-length'] = meta['content-range']
    ? parseInt(meta['content-range'].split('/')[1], 10)
    : 0;
  return meta;
}
/**
 * get request stream with range
 */
function getRangeStreamFromUrl({ url, start, end, timeout = 5 * 60 * 1000 }) {
  const headers =    start || end
    ? {
      range: `bytes=${start}-${end - 1}`,
    }
    : {};
  let req = request({
    url,
    timeout,
    headers,
  }).on('response', (response) => {
    if (!`${response.statusCode}`.startsWith('2')) {
      req.emit('error', {
        url: url.replace(/(\?[\s\S]*)/g, ''),
        statusCode: response.statusCode,
        headers: response.headers || {},
      });
    }
    req = null;
  });
  return readStreamAddPassThrough(req);
}
/**
 * ReadStream add PassThrough, when ReadStream emit error, proxy error to PassThrough
 */
function readStreamAddPassThrough(readStream) {
  const passThrough = new PassThrough();
  readStream.on('error', err => passThrough.emit('error', err));
  return readStream.pipe(passThrough);
}
/**
 * get stream pipeline promise
 */
function streamPipelinePromise(streams) {
  return new Promise((resolve, reject) => {
    const lastStream = streams[streams.length - 1];
    lastStream.on('finish', resolve);
    pipeline(streams, (err) => {
      if (err) {
        reject(err);
      }
    });
  });
}
/**
 * run promises with limit
 */
function promiseMapLimit({ list, func, limit = 1 }) {
  return new Promise((resolve, reject) => {
    Async.mapLimit(
      list,
      limit,
      async (item) => {
        const res = await func(item);
        return res;
      },
      (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      },
    );
  });
}
/**
 * replace the placeholder of template by map
 */
function replaceTemplate(template = '', map = {}) {
  const reg = Object.keys(map)
    .map(key => key.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1'))
    .join('|');
  return template.replace(
    new RegExp(reg, 'gm'),
    placeholer => map[placeholer] || '',
  );
}
/**
 * get object by keys
 */
function getData(object, keys = []) {
  return keys.reduce((res, key) => {
    if (object[key]) {
      res[key] = object[key];
    }
    return res;
  }, {});
}
/**
 * get diff list
 */
function getDiffList(sourceList, compareList) {
  return sourceList.reduce((res, item) => {
    if (!compareList.includes(item)) {
      res.push(item);
    }
    return res;
  }, []);
}
/**
 * filter data null property
 */
function getNotNullData(data) {
  return Object.keys(data).reduce((res, key) => {
    const value = data[key];
    if (value !== undefined && value !== null) {
      res[key] = value;
    }
    return res;
  }, {});
}
/**
 * sleep logic
 */
function sleep(duration) {
  return new Promise(r => setTimeout(r, duration));
}
/**
 * get retry function
 */
function retry({ maxTryTime = 3, duration = 500, func }) {
  return async (...args) => {
    let err;
    let tryTime = 0;
    while (tryTime < maxTryTime) {
      tryTime += 1;
      try {
        const res = await func(...args);
        return res;
      } catch (e) {
        err = e;
        if (tryTime < maxTryTime) {
          await sleep(duration);
        }
      }
    }
    throw err;
  };
}
/**
 * try to get stringify string of data
 */
function tryStringify(data) {
  try {
    return JSON.stringify(data);
  } catch (err) {
    return data;
  }
}
/**
 * print log message
 */
function logger({ messages = [], title = '', data = {} }) {
  const messageList = [...messages, title];
  for (const key in data) {
    const value = data[key];
    try {
      messageList.push(`${key}: ${inspect(value, { depth: 10 })}`);
    } catch (err) {
      messageList.push(`${key}: [inspect error]`);
    }
  }
  const result = `${messageList.filter(Boolean).join('\n')}`;
  console.log(`${result}\n\n`);
  return result;
}
/**
 * get log summary
 */
function getLogSummary({ name = '', results }) {
  let success = 0;
  let total = 0;
  const details = [];
  const limit = 20;
  const truncated = results.length > limit;
  const hasError = results.filter(item => item.error).length > 0;
  for (const { params, result, error } of results) {
    if (error) {
      if (details.length < limit) {
        details.push(`TaskStatus: fail\nParams: ${JSON.stringify(params)}\nError: ${inspect(error, { depth: 10 })}`);
      }
    } else {
      if (details.length < limit && !(truncated && hasError)) {
        details.push(`TaskStatus: success\nParams: ${JSON.stringify(params)}\nResult: ${JSON.stringify(result)}`);
      }
      success += 1;
    }
    total += 1;
  }
  return {
    status: success < total ? 'fail' : 'success',
    messages: [
      `Result: ${name} ${
        success === total ? 'success' : 'fail'
      }\nsuccess: ${success}\ntotal: ${total}`,
      ...details,
    ].filter(Boolean),
  };
}

module.exports = {
  getParams,
  getFinalValue,
  getClassifyList,
  getCosSdkInstance,
  parseUrl,
  tryAddCosSignature,
  getMetaFromUrl,
  getRangeStreamFromUrl,
  readStreamAddPassThrough,
  streamPipelinePromise,
  promiseMapLimit,
  replaceTemplate,
  getData,
  getDiffList,
  requestPromiseRetry,
  getNotNullData,
  sleep,
  retry,
  tryStringify,
  logger,
  getLogSummary,
};