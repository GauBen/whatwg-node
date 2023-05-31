import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { CurlPause } from 'node-libcurl';
import type { CurlyOptions } from 'node-libcurl/dist/curly.js';
import { EasyNativeBinding } from 'node-libcurl/dist/types/index.js';
import { PonyfillBlob } from './Blob.js';
import { PonyfillHeaders } from './Headers.js';
import { PonyfillRequest, RequestPonyfillInit } from './Request.js';
import { PonyfillResponse } from './Response.js';
import { PonyfillURL } from './URL.js';

function getResponseForFile(url: string) {
  const path = fileURLToPath(url);
  const readable = createReadStream(path);
  return new PonyfillResponse(readable);
}

function getResponseForDataUri(url: URL) {
  const [mimeType = 'text/plain', ...datas] = url.pathname.split(',');
  const data = decodeURIComponent(datas.join(','));
  if (mimeType.endsWith(BASE64_SUFFIX)) {
    const buffer = Buffer.from(data, 'base64url');
    const realMimeType = mimeType.slice(0, -BASE64_SUFFIX.length);
    const file = new PonyfillBlob([buffer], { type: realMimeType });
    return new PonyfillResponse(file, {
      status: 200,
      statusText: 'OK',
    });
  }
  return new PonyfillResponse(data, {
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': mimeType,
    },
  });
}

const BASE64_SUFFIX = ';base64';

export async function fetchPonyfill<TResponseJSON = any, TRequestJSON = any>(
  info: string | PonyfillRequest<TRequestJSON> | URL,
  init?: RequestPonyfillInit,
): Promise<PonyfillResponse<TResponseJSON>> {
  if (typeof info === 'string' || 'href' in info) {
    const ponyfillRequest = new PonyfillRequest(info, init);
    return fetchPonyfill(ponyfillRequest);
  }

  const fetchRequest = info;

  const url = new PonyfillURL(fetchRequest.url, 'http://localhost');

  if (url.protocol === 'data:') {
    const response = getResponseForDataUri(url);
    return Promise.resolve(response);
  }

  if (url.protocol === 'file:') {
    const response = getResponseForFile(fetchRequest.url);
    return Promise.resolve(response);
  }

  const nodeReadable = (
    fetchRequest.body != null
      ? 'pipe' in fetchRequest.body
        ? fetchRequest.body
        : Readable.from(fetchRequest.body)
      : null
  ) as Readable | null;

  const curlyHeaders: string[] = [];

  let size: number | undefined;

  fetchRequest.headers.forEach((value, key) => {
    curlyHeaders.push(`${key}: ${value}`);
    if (key === 'content-length') {
      size = Number(value);
    }
  });

  let easyNativeBinding: EasyNativeBinding | undefined;

  fetchRequest.signal.onabort = () => {
    if (easyNativeBinding != null) {
      easyNativeBinding.pause(CurlPause.Recv);
    }
  };

  const curlyOptions: CurlyOptions = {
    // we want the unparsed binary response to be returned as a stream to us
    curlyStreamResponse: true,
    curlyResponseBodyParser: false,
    curlyProgressCallback() {
      if (easyNativeBinding == null) {
        easyNativeBinding = this;
      }
      return fetchRequest.signal.aborted ? 1 : 0;
    },
    upload: nodeReadable != null,
    transferEncoding: false,
    httpTransferDecoding: true,
    followLocation: fetchRequest.redirect === 'follow',
    maxRedirs: 20,
    acceptEncoding: '',
    curlyStreamUpload: nodeReadable,
    // this will just make libcurl use their own progress function (which is pretty neat)
    // curlyProgressCallback() { return CurlProgressFunc.Continue },
    // verbose: true,
    httpHeader: curlyHeaders,
    customRequest: fetchRequest.method,
  };

  if (size != null) {
    curlyOptions.inFileSize = size;
  }

  const { curly, CurlCode } = await import('node-libcurl');

  const curlyResult = await curly(fetchRequest.url, curlyOptions);

  const responseHeaders = new PonyfillHeaders();
  curlyResult.headers.forEach(headerInfo => {
    for (const key in headerInfo) {
      if (key === 'location' || (key === 'Location' && fetchRequest.redirect === 'error')) {
        throw new Error('redirects are not allowed');
      }
      if (key !== 'result') {
        responseHeaders.append(key, headerInfo[key]);
      }
    }
  });
  curlyResult.data.on('error', (err: any) => {
    if (err.isCurlError && err.code === CurlCode.CURLE_ABORTED_BY_CALLBACK) {
      // this is expected
    } else {
      throw err;
    }
  });

  return new PonyfillResponse(curlyResult.data, {
    status: curlyResult.statusCode,
    headers: responseHeaders,
    url: info.url,
  });
}
