import { cache, eventTarget, EVENTS } from '@cornerstonejs/core';

const MAX_EVENT_SAMPLES = 5000;

type CacheEntry = {
  imageId: string;
  studyInstanceUID: string | null;
  seriesInstanceUID: string | null;
  bytes: number | null;
  wasInEnabledViewportAtLoad: boolean;
  loadedAtMs: number;
};

type CacheEvent = CacheEntry & {
  action: 'added' | 'removed';
  atMs: number;
};

function getImageBytes(image): number | null {
  const size = Number(image?.sizeInBytes ?? image?.imageFrame?.pixelData?.byteLength);
  return Number.isFinite(size) ? size : null;
}

export default function initCfndapSeriesCacheInstrumentation(ohif) {
  const debugApi = (window as any).__CFNDAP_OHIF_DEBUG__;
  if (!debugApi?.enabled?.()) {
    return;
  }

  const csCache = cache as any;
  if (csCache.__cfndapSeriesCacheInstrumentationInstalled) {
    return;
  }

  const entriesByImageId = new Map<string, CacheEntry>();
  const events: CacheEvent[] = [];

  const appendEvent = (action: CacheEvent['action'], entry: CacheEntry) => {
    if (events.length < MAX_EVENT_SAMPLES) {
      events.push({ action, atMs: Math.round(performance.now()), ...entry });
    }
  };

  const getImageMetadata = (imageId: string) => {
    try {
      const instance = ohif.classes.MetadataProvider.getInstance(imageId);
      return {
        studyInstanceUID: instance?.StudyInstanceUID ?? null,
        seriesInstanceUID: instance?.SeriesInstanceUID ?? null,
      };
    } catch {
      // Non-DICOM image IDs may not have an OHIF metadata entry.
      return { studyInstanceUID: null, seriesInstanceUID: null };
    }
  };

  const isInEnabledViewport = (imageId: string) => {
    try {
      const enabledElements = (window as any).cornerstone?.getEnabledElements?.() || [];
      return enabledElements.some(enabledElement =>
        enabledElement.viewport?.getImageIds?.().includes(imageId)
      );
    } catch {
      return false;
    }
  };

  const recordLoadedImage = event => {
    const eventImage = event.detail?.image;
    const imageId = event.detail?.imageId ?? eventImage?.imageId;
    if (!imageId || entriesByImageId.has(imageId)) {
      return;
    }
    const image = eventImage ?? csCache.getImage?.(imageId);

    const entry: CacheEntry = {
      imageId,
      ...getImageMetadata(imageId),
      bytes: getImageBytes(image),
      wasInEnabledViewportAtLoad: isInEnabledViewport(imageId),
      loadedAtMs: Math.round(performance.now()),
    };
    entriesByImageId.set(imageId, entry);
    appendEvent('added', entry);
  };

  const originalRemoveImageLoadObject = csCache.removeImageLoadObject.bind(csCache);
  csCache.removeImageLoadObject = (imageId: string, options?: unknown) => {
    const entry = entriesByImageId.get(imageId);
    const result = originalRemoveImageLoadObject(imageId, options);

    if (entry) {
      entriesByImageId.delete(imageId);
      appendEvent('removed', entry);
    }

    return result;
  };

  const getSummary = () => {
    const bySeries = new Map<
      string,
      {
        studyInstanceUID: string | null;
        seriesInstanceUID: string | null;
        imageCount: number;
        enabledViewportImageCount: number;
        knownBytes: number;
        unknownByteCount: number;
      }
    >();

    for (const entry of entriesByImageId.values()) {
      const key = entry.seriesInstanceUID ?? 'unknown-series';
      const series = bySeries.get(key) ?? {
        studyInstanceUID: entry.studyInstanceUID,
        seriesInstanceUID: entry.seriesInstanceUID,
        imageCount: 0,
        enabledViewportImageCount: 0,
        knownBytes: 0,
        unknownByteCount: 0,
      };
      series.imageCount += 1;
      if (isInEnabledViewport(entry.imageId)) {
        series.enabledViewportImageCount += 1;
      }
      if (entry.bytes === null) {
        series.unknownByteCount += 1;
      } else {
        series.knownBytes += entry.bytes;
      }
      bySeries.set(key, series);
    }

    return {
      cacheBytes: csCache.getCacheSize(),
      cacheFreeBytes: csCache.getBytesAvailable(),
      trackedImageCount: entriesByImageId.size,
      addedEventCount: events.filter(event => event.action === 'added').length,
      removedEventCount: events.filter(event => event.action === 'removed').length,
      series: [...bySeries.values()].sort((a, b) => b.knownBytes - a.knownBytes),
    };
  };

  (window as any).__CFNDAP_OHIF_CACHE_DEBUG__ = {
    getSummary,
    printSummary() {
      const summary = getSummary();
      console.table(summary.series);
      console.log('[CFNDAP][OHIF][series-cache-summary]', summary);
      return summary;
    },
    state: {
      entriesByImageId,
      events,
    },
  };

  eventTarget.addEventListener(EVENTS.IMAGE_LOADED, recordLoadedImage);
  csCache.__cfndapSeriesCacheInstrumentationInstalled = true;
}
