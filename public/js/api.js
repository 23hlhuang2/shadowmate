function makeError(body, status) {
  const info = body && body.error ? body.error : {};
  const err = new Error(info.message || `请求失败（HTTP ${status}）`);
  err.status = status;
  err.code = info.code || 'REQUEST_FAILED';
  err.detail = info.detail;
  return err;
}

async function request(path, options = {}) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) throw makeError(body, res.status);
  return body;
}

export function health() {
  return request('/api/health');
}

/** 原始音频的播放地址（支持 Range，可拖动跳转）。 */
export function audioFileUrl(audioId) {
  return `/api/audios/${encodeURIComponent(audioId)}/file`;
}

/** 用 XHR 上传以拿到真实的上传进度事件；signal 用于取消上传。 */
export function uploadAudio(file, durationSec, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(Object.assign(new Error('已取消上传'), { code: 'ABORTED' }));
      return;
    }

    const xhr = new XMLHttpRequest();
    const query = `name=${encodeURIComponent(file.name)}&duration=${durationSec ?? ''}`;
    xhr.open('POST', `/api/audios?${query}`, true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    const onAbort = () => xhr.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      cleanup();
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* 忽略 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(makeError(body, xhr.status));
    };
    xhr.onabort = () => {
      cleanup();
      reject(Object.assign(new Error('已取消上传'), { code: 'ABORTED' }));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('网络错误，上传失败，请重试'));
    };
    xhr.send(file);
  });
}

export function segmentAudio(audioId) {
  return request(`/api/audios/${encodeURIComponent(audioId)}/segment`, { method: 'POST' });
}

/** 提交浏览器本地识别结果，由服务端复用同一套分句规则切句。 */
export function submitTranscript(audioId, transcript) {
  return request(`/api/audios/${encodeURIComponent(audioId)}/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transcript)
  });
}

export function getAudio(audioId) {
  return request(`/api/audios/${encodeURIComponent(audioId)}`);
}

export function assessUnit(audioId, unitIndex, wavBlob, durationSec) {
  return request(
    `/api/audios/${encodeURIComponent(audioId)}/units/${unitIndex}/assess?duration=${durationSec.toFixed(2)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBlob
    }
  );
}