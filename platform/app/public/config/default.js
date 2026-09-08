(function installCfndapDicomAuth() {
  const readSharedToken = () => {
    try {
      const token = window.localStorage.getItem('token');
      return token && token.trim().length > 0 ? token : '';
    } catch {
      return '';
    }
  };

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async (...args) => {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input?.url;

      if (url && url.includes('/api/dicom-web')) {
        const token = readSharedToken();
        const headers = new Headers(init?.headers || {});

        if (token && !headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${token}`);
        }

        return originalFetch(input, {
          ...(init || {}),
          headers,
        });
      }

      return originalFetch(...args);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__cfndapDicomAuth = { url, hasAuthorization: false };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (
      this.__cfndapDicomAuth
      && name.toLowerCase() === 'authorization'
      && typeof value === 'string'
      && value.trim().length > 0
    ) {
      this.__cfndapDicomAuth.hasAuthorization = true;
    }

    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    if (this.__cfndapDicomAuth?.url?.includes('/api/dicom-web')) {
      const token = readSharedToken();
      if (token && !this.__cfndapDicomAuth.hasAuthorization) {
        originalSetRequestHeader.call(this, 'Authorization', `Bearer ${token}`);
        this.__cfndapDicomAuth.hasAuthorization = true;
      }
    }

    return originalSend.apply(this, args);
  };
})();

(function installCfndapOhifDebug() {
  const DEBUG_FLAG = 'cfndap_ohif_debug';
  const MAX_REQUEST_SAMPLES = 5000;
  const isEnabled = () => {
    try {
      return window.localStorage.getItem(DEBUG_FLAG) === '1'
        || window.location.search.includes('cfndapDebug=1');
    } catch {
      return false;
    }
  };
  const getHeap = () => {
    const memory = performance.memory;
    if (!memory) {
      return null;
    }
    return {
      usedMiB: Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10,
      totalMiB: Math.round((memory.totalJSHeapSize / 1024 / 1024) * 10) / 10,
      limitMiB: Math.round((memory.jsHeapSizeLimit / 1024 / 1024) * 10) / 10,
    };
  };
  const state = {
    requests: [],
    snapshots: [],
    summary: {
      totalRequests: 0,
      totalBytes: 0,
      activeRequests: 0,
      failedRequests: 0,
      droppedRequestSamples: 0,
    },
    memory: { initial: getHeap(), peakUsedMiB: null },
    jank: { longTasksCount: 0, totalBlockingTimeMs: 0, longestTaskMs: 0 },
    requestPools: null,
    firstImageRenderedAtMs: null,
  };
  if (state.memory.initial) {
    state.memory.peakUsedMiB = state.memory.initial.usedMiB;
  }
  const updateHeapPeak = () => {
    const heap = getHeap();
    if (heap) {
      state.memory.peakUsedMiB = Math.max(state.memory.peakUsedMiB || 0, heap.usedMiB);
    }
    return heap;
  };
  const trackableUrl = url => typeof url === 'string' && url.includes('/api/dicom-web');
  const appendRequest = request => {
    if (state.requests.length >= MAX_REQUEST_SAMPLES) {
      state.summary.droppedRequestSamples += 1;
      return;
    }
    state.requests.push(request);
  };
  const readResponseBytes = headers => {
    const raw = headers?.get?.('content-length');
    const bytes = Number(raw);
    return Number.isFinite(bytes) ? bytes : null;
  };
  const snapshot = (label, details = {}) => {
    const entry = {
      label,
      atMs: Math.round(performance.now()),
      heap: updateHeapPeak(),
      requestSummary: { ...state.summary },
      requestPools: state.requestPools,
      ...details,
    };
    state.snapshots.push(entry);
    console.log('[CFNDAP][OHIF][snapshot]', entry);
    return entry;
  };
  const mark = (name, details) => {
    performance.mark(`cfndap:${name}`);
    return snapshot(name, details);
  };
  let heapTimer;
  let longTaskObserver;
  const cleanup = () => {
    window.clearInterval(heapTimer);
    longTaskObserver?.disconnect();
  };

  window.__CFNDAP_OHIF_DEBUG__ = {
    enabled: isEnabled,
    state,
    snapshot,
    markStudyLoadStart: details => mark('study-load-start', details),
    markFirstImageRendered: details => {
      if (state.firstImageRenderedAtMs !== null) {
        return snapshot('image-rendered', { ...details, isFirstImage: false });
      }
      const start = performance.getEntriesByName('cfndap:study-load-start').at(-1);
      const end = performance.mark('cfndap:first-image-rendered');
      state.firstImageRenderedAtMs = end.startTime;
      return snapshot('first-image-rendered', {
        ...details,
        timeToFirstImageMs: start ? Math.round(end.startTime - start.startTime) : null,
      });
    },
    setRequestPoolStats: requestPools => {
      state.requestPools = requestPools;
    },
    printSummary() {
      const currentHeap = updateHeapPeak();
      console.table(state.requests);
      console.log('[CFNDAP][OHIF][network-summary]', state.summary);
      console.log('[CFNDAP][OHIF][system-vitals]', {
        initialHeap: state.memory.initial,
        currentHeap,
        peakUsedMiB: state.memory.peakUsedMiB,
        ...state.jank,
        requestPools: state.requestPools,
      });
      return { summary: state.summary, memory: state.memory, jank: state.jank };
    },
    clear() {
      state.requests.splice(0);
      state.snapshots.splice(0);
      state.firstImageRenderedAtMs = null;
      Object.assign(state.summary, {
        totalRequests: 0,
        totalBytes: 0,
        activeRequests: 0,
        failedRequests: 0,
        droppedRequestSamples: 0,
      });
    },
    cleanup,
  };

  if (!isEnabled()) {
    return;
  }
  heapTimer = window.setInterval(updateHeapPeak, 1000);
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver(list => {
        list.getEntries().forEach(entry => {
          state.jank.longTasksCount += 1;
          state.jank.totalBlockingTimeMs += Math.max(0, entry.duration - 50);
          state.jank.longestTaskMs = Math.max(state.jank.longestTaskMs, Math.round(entry.duration));
        });
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      // Long Task API availability differs across browsers.
    }
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async (...args) => {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input?.url;
      if (!trackableUrl(url)) {
        return originalFetch(...args);
      }
      const startedAt = performance.now();
      state.summary.totalRequests += 1;
      state.summary.activeRequests += 1;
      try {
        const response = await originalFetch(...args);
        const bytes = readResponseBytes(response.headers);
        appendRequest({
          kind: 'fetch', method: init?.method || 'GET', url, status: response.status,
          ok: response.ok, durationMs: Math.round(performance.now() - startedAt), bytes,
        });
        if (bytes !== null) state.summary.totalBytes += bytes;
        if (!response.ok) state.summary.failedRequests += 1;
        return response;
      } catch (error) {
        appendRequest({
          kind: 'fetch', method: init?.method || 'GET', url, status: 'NETWORK_ERROR',
          ok: false, durationMs: Math.round(performance.now() - startedAt), bytes: null,
          error: error?.message || 'unknown error',
        });
        state.summary.failedRequests += 1;
        throw error;
      } finally {
        state.summary.activeRequests -= 1;
      }
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__cfndapOhifDebug = { method, url };
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const debug = this.__cfndapOhifDebug;
    if (!debug || !trackableUrl(debug.url)) {
      return originalSend.apply(this, args);
    }
    const startedAt = performance.now();
    state.summary.totalRequests += 1;
    state.summary.activeRequests += 1;
    this.addEventListener('loadend', () => {
      const raw = this.getResponseHeader('content-length');
      const bytes = Number(raw);
      appendRequest({
        kind: 'xhr', method: debug.method || 'GET', url: debug.url, status: this.status,
        ok: this.status >= 200 && this.status < 400,
        durationMs: Math.round(performance.now() - startedAt),
        bytes: Number.isFinite(bytes) ? bytes : null,
      });
      if (Number.isFinite(bytes)) state.summary.totalBytes += bytes;
      if (!(this.status >= 200 && this.status < 400)) state.summary.failedRequests += 1;
      state.summary.activeRequests -= 1;
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();

/** @type {AppTypes.Config} */
window.config = {
  name: 'config/default.js',
  routerBasename: '/ohif',
  extensions: [],
  modes: ['@ohif/mode-basic-dev-mode'],
  customizationService: [
    {
      'studyBrowser.studyMode': {
        // Keep the study browser visible, but restrict it to the launched study
        // instead of showing same-patient priors from additional study queries.
        $set: 'primary',
      },
    },
  ],
  showStudyList: true,
  maxNumberOfWebWorkers: 3,
  showLoadingIndicator: true,
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  strictZSpacingForVolumeViewport: true,
  defaultDataSourceName: 'orthanc',
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'orthanc',
      configuration: {
        friendlyName: 'cfndap DICOM Proxy',
        name: 'DCM4CHEE',
        wadoUriRoot: '/api/dicom-web',
        qidoRoot: '/api/dicom-web',
        wadoRoot: '/api/dicom-web',
        qidoSupportsIncludeField: true,
        supportsReject: false,
        dicomUploadEnabled: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'rendered',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: true,
        supportsWildcard: true,
        omitQuotationForMultipartRequest: true,
        bulkDataURI: { enabled: true, relativeResolution: 'studies' },
      },
    },
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomjson',
      sourceName: 'dicomjson',
      configuration: {
        friendlyName: 'dicom json',
        name: 'json',
      },
    },
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomlocal',
      sourceName: 'dicomlocal',
      configuration: {
        friendlyName: 'dicom local',
      },
    },
  ],
  httpErrorHandler: (error) => {
    if (error.status === 401) {
      console.warn('[OHIF] 401 Unauthorized - Bioloop session may have expired.');
      window.location.assign('/auth/logout');
    }
  },
};
