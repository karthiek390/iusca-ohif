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
        thumbnailRendering: 'wadors',
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
