import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useImageViewer } from '@ohif/ui-next';
import { useSystem, utils } from '@ohif/core';
import { useLocation, useNavigate } from 'react-router-dom';
import { useViewportGrid, StudyBrowser, Separator } from '@ohif/ui-next';
import { PanelStudyBrowserHeader } from './PanelStudyBrowserHeader';
import { defaultActionIcons } from './constants';
import MoreDropdownMenu from '../../Components/MoreDropdownMenu';
import { CallbackCustomization } from 'platform/core/src/types';
import { type TabsProps } from '@ohif/core/src/utils/createStudyBrowserTabs';

const { sortStudyInstances, formatDate, createStudyBrowserTabs } = utils;

const thumbnailNoImageModalities = ['SR', 'SEG', 'RTSTRUCT', 'RTPLAN', 'RTDOSE', 'DOC', 'PMAP'];

/**
 * Study Browser component that displays and manages studies and their display sets
 */
function PanelStudyBrowser({
  getImageSrc,
  getStudiesForPatientByMRN,
  requestDisplaySetCreationForStudy,
  dataSource,
  customMapDisplaySets,
  onClickUntrack,
  onDoubleClickThumbnailHandlerCallBack,
}) {
  const { servicesManager, commandsManager, extensionManager } = useSystem();
  const { displaySetService, customizationService } = servicesManager.services;
  const navigate = useNavigate();
  const { search } = useLocation();
  const primaryStudyOnly = new URLSearchParams(search).get('primaryStudyOnly') === 'true';
  const studyMode =
    (customizationService.getCustomization('studyBrowser.studyMode') as string) || 'all';

  const internalImageViewer = useImageViewer();
  const StudyInstanceUIDs = internalImageViewer.StudyInstanceUIDs;
  const fetchedStudiesRef = useRef(new Set());

  const [{ activeViewportId, viewports, isHangingProtocolLayout }] = useViewportGrid();
  const [activeTabName, setActiveTabName] = useState(studyMode);
  const [expandedStudyInstanceUIDs, setExpandedStudyInstanceUIDs] = useState(
    studyMode === 'primary' && StudyInstanceUIDs.length > 0
      ? [StudyInstanceUIDs[0]]
      : [...StudyInstanceUIDs]
  );
  const [hasLoadedViewports, setHasLoadedViewports] = useState(false);
  const [studyDisplayList, setStudyDisplayList] = useState([]);
  const [displaySets, setDisplaySets] = useState([]);
  const [displaySetsLoadingState, setDisplaySetsLoadingState] = useState({});
  const [thumbnailImageSrcMap, setThumbnailImageSrcMap] = useState({});
  const [lazyCatalogDisplaySets, setLazyCatalogDisplaySets] = useState([]);
  const [jumpToDisplaySet, setJumpToDisplaySet] = useState(null);
  const [visibleThumbnailDisplaySetInstanceUIDs, setVisibleThumbnailDisplaySetInstanceUIDs] =
    useState([]);
  const thumbnailLoadQueueRef = useRef([]);
  const thumbnailLoadInFlightRef = useRef(0);
  const thumbnailLoadRequestedRef = useRef(new Set());
  const thumbnailCacheOrderRef = useRef([]);
  const visibleThumbnailIdsRef = useRef(new Set());

  const virtualizeThumbnails =
    typeof window !== 'undefined' &&
    window.localStorage.getItem('cfndap_ohif_virtual_sidebar') === '1';
  const virtualizeThumbnailsRef = useRef(virtualizeThumbnails);
  virtualizeThumbnailsRef.current = virtualizeThumbnails;

  const lazySeriesMetadataEnabled =
    typeof window !== 'undefined' &&
    window.localStorage.getItem('cfndap_ohif_lazy_series_metadata') === '1';

  const [viewPresets, setViewPresets] = useState(
    customizationService.getCustomization('studyBrowser.viewPresets')
  );

  const [actionIcons, setActionIcons] = useState(defaultActionIcons);

  const refreshLazyCatalog = useCallback(() => {
    const lazyMetadataApi = (window as any).__CFNDAP_OHIF_LAZY_SERIES_METADATA__;
    if (!lazySeriesMetadataEnabled || !lazyMetadataApi?.enabled?.()) {
      setLazyCatalogDisplaySets([]);
      return;
    }

    setLazyCatalogDisplaySets(
      lazyMetadataApi.getCatalog().filter(series => !series.hydrated).map(series => ({
        displaySetInstanceUID: `cfndap-lazy:${series.seriesInstanceUID}`,
        SeriesInstanceUID: series.seriesInstanceUID,
        StudyInstanceUID: series.studyInstanceUID,
        SeriesNumber: series.seriesNumber,
        SeriesDescription: series.seriesDescription || '',
        Modality: series.modality,
        description: series.seriesDescription || '',
        seriesNumber: series.seriesNumber,
        modality: series.modality,
        componentType: 'thumbnail',
        numInstances: 0,
        isLazyMetadataPlaceholder: true,
      }))
    );
  }, [lazySeriesMetadataEnabled]);

  const mergeLazyCatalogDisplaySets = useCallback(
    mappedDisplaySets => {
      if (!lazySeriesMetadataEnabled) {
        return mappedDisplaySets;
      }

      const hydratedSeriesUIDs = new Set(
        mappedDisplaySets.map(displaySet => displaySet.SeriesInstanceUID)
      );
      return [
        ...mappedDisplaySets,
        ...lazyCatalogDisplaySets.filter(
          displaySet => !hydratedSeriesUIDs.has(displaySet.SeriesInstanceUID)
        ),
      ];
    },
    [lazyCatalogDisplaySets, lazySeriesMetadataEnabled]
  );

  useEffect(() => {
    if (!lazySeriesMetadataEnabled) {
      return;
    }

    window.addEventListener('cfndap:series-metadata-catalog-ready', refreshLazyCatalog);
    window.addEventListener('cfndap:series-metadata-hydrated', refreshLazyCatalog);
    refreshLazyCatalog();

    return () => {
      window.removeEventListener('cfndap:series-metadata-catalog-ready', refreshLazyCatalog);
      window.removeEventListener('cfndap:series-metadata-hydrated', refreshLazyCatalog);
    };
  }, [lazySeriesMetadataEnabled, refreshLazyCatalog]);

  const storeThumbnailImageSrc = useCallback((displaySetInstanceUID, thumbnailSrc) => {
    const maxThumbnailImageSrcEntries = 96;
    const order = thumbnailCacheOrderRef.current.filter(id => id !== displaySetInstanceUID);
    order.push(displaySetInstanceUID);

    setThumbnailImageSrcMap(previous => {
      const next = { ...previous, [displaySetInstanceUID]: thumbnailSrc };
      while (order.length > maxThumbnailImageSrcEntries) {
        delete next[order.shift()];
      }
      return next;
    });

    thumbnailCacheOrderRef.current = order;
  }, []);

  const loadThumbnail = useCallback(
    async dSet => {
      if (dSet.isLazyMetadataPlaceholder) {
        return;
      }
      const displaySetInstanceUID = dSet.displaySetInstanceUID;
      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
      if (displaySet?.unsupported) {
        return;
      }

      const imageIds = dataSource.getImageIdsForDisplaySet(dSet);
      const imageId = getImageIdForThumbnail(displaySet, imageIds);
      let { thumbnailSrc } = displaySet;

      if (!thumbnailSrc && displaySet.getThumbnailSrc) {
        thumbnailSrc = await displaySet.getThumbnailSrc({ getImageSrc });
      }
      if (!thumbnailSrc && imageId) {
        thumbnailSrc = await getImageSrc(imageId);
        displaySet.thumbnailSrc = thumbnailSrc;
      }

      if (thumbnailSrc) {
        if (
          !virtualizeThumbnailsRef.current ||
          visibleThumbnailIdsRef.current.has(displaySetInstanceUID)
        ) {
          storeThumbnailImageSrc(displaySetInstanceUID, thumbnailSrc);
        }
      }
    },
    [dataSource, displaySetService, getImageSrc, storeThumbnailImageSrc]
  );

  const scheduleThumbnailLoad = useCallback(
    dSet => {
      const displaySetInstanceUID = dSet.displaySetInstanceUID;
      if (thumbnailLoadRequestedRef.current.has(displaySetInstanceUID)) {
        return;
      }

      thumbnailLoadRequestedRef.current.add(displaySetInstanceUID);
      thumbnailLoadQueueRef.current.push(dSet);

      const startNext = () => {
        while (thumbnailLoadInFlightRef.current < 3 && thumbnailLoadQueueRef.current.length) {
          const queuedDisplaySet = thumbnailLoadQueueRef.current.shift();
          if (
            virtualizeThumbnailsRef.current &&
            !visibleThumbnailIdsRef.current.has(queuedDisplaySet.displaySetInstanceUID)
          ) {
            thumbnailLoadRequestedRef.current.delete(queuedDisplaySet.displaySetInstanceUID);
            continue;
          }
          thumbnailLoadInFlightRef.current += 1;
          loadThumbnail(queuedDisplaySet)
            .catch(error => {
              thumbnailLoadRequestedRef.current.delete(queuedDisplaySet.displaySetInstanceUID);
              console.warn('Unable to load Study Browser thumbnail', error);
            })
            .finally(() => {
              thumbnailLoadInFlightRef.current -= 1;
              startNext();
            });
        }
      };

      startNext();
    },
    [loadThumbnail]
  );

  const onVisibleThumbnailIdsChange = useCallback(displaySetInstanceUIDs => {
    visibleThumbnailIdsRef.current = new Set(displaySetInstanceUIDs);
    setVisibleThumbnailDisplaySetInstanceUIDs(previous => {
      if (
        previous.length === displaySetInstanceUIDs.length &&
        previous.every((id, index) => id === displaySetInstanceUIDs[index])
      ) {
        return previous;
      }
      return displaySetInstanceUIDs;
    });
  }, []);

  // multiple can be true or false
  const updateActionIconValue = actionIcon => {
    actionIcon.value = !actionIcon.value;
    const newActionIcons = [...actionIcons];
    setActionIcons(newActionIcons);
  };

  // only one is true at a time
  const updateViewPresetValue = viewPreset => {
    if (!viewPreset) {
      return;
    }
    const newViewPresets = viewPresets.map(preset => {
      preset.selected = preset.id === viewPreset.id;
      return preset;
    });
    setViewPresets(newViewPresets);
  };

  const mapDisplaySetsWithState = customMapDisplaySets || _mapDisplaySets;

  const runDoubleClickThumbnailHandler = useCallback(
    async displaySetInstanceUID => {
      const customHandler = customizationService.getCustomization(
        'studyBrowser.thumbnailDoubleClickCallback'
      ) as CallbackCustomization;

      const setupArgs = {
        activeViewportId,
        commandsManager,
        servicesManager,
        isHangingProtocolLayout,
        appConfig: extensionManager._appConfig,
      };

      const handlers = customHandler?.callbacks.map(callback => callback(setupArgs));

      for (const handler of handlers) {
        await handler(displaySetInstanceUID);
      }
      onDoubleClickThumbnailHandlerCallBack?.(displaySetInstanceUID);
    },
    [
      activeViewportId,
      commandsManager,
      servicesManager,
      isHangingProtocolLayout,
      customizationService,
    ]
  );

  const onDoubleClickThumbnailHandler = useCallback(
    async displaySetInstanceUID => {
      if (!displaySetInstanceUID.startsWith('cfndap-lazy:')) {
        return runDoubleClickThumbnailHandler(displaySetInstanceUID);
      }

      const seriesInstanceUID = displaySetInstanceUID.replace('cfndap-lazy:', '');
      await (window as any).__CFNDAP_OHIF_LAZY_SERIES_METADATA__?.hydrateSeries(seriesInstanceUID);

      const hydratedDisplaySet = displaySetService
        .getActiveDisplaySets()
        .find(displaySet => displaySet.SeriesInstanceUID === seriesInstanceUID);
      if (hydratedDisplaySet) {
        await runDoubleClickThumbnailHandler(hydratedDisplaySet.displaySetInstanceUID);
      }
    },
    [displaySetService, runDoubleClickThumbnailHandler]
  );

  const onClickThumbnailHandler = useCallback(async displaySetInstanceUID => {
    if (!displaySetInstanceUID.startsWith('cfndap-lazy:')) {
      return;
    }

    const seriesInstanceUID = displaySetInstanceUID.replace('cfndap-lazy:', '');
    await (window as any).__CFNDAP_OHIF_LAZY_SERIES_METADATA__?.hydrateSeries(seriesInstanceUID);
  }, []);

  // ~~ studyDisplayList
  useEffect(() => {
    // Fetch all studies for the patient in each primary study
    async function fetchStudiesForPatient(StudyInstanceUID) {
      // Skip fetching if we've already fetched this study
      if (fetchedStudiesRef.current.has(StudyInstanceUID)) {
        return;
      }

      fetchedStudiesRef.current.add(StudyInstanceUID);

      // current study qido
      const qidoForStudyUID = await dataSource.query.studies.search({
        studyInstanceUid: StudyInstanceUID,
      });

      if (!qidoForStudyUID?.length) {
        navigate('/notfoundstudy', '_self');
        throw new Error('Invalid study URL');
      }

      let qidoStudiesForPatient = qidoForStudyUID;

      // Scoped launches must not query same-patient priors; the primary study is already resolved above.
      if (!primaryStudyOnly) {
        try {
          qidoStudiesForPatient = await getStudiesForPatientByMRN(qidoForStudyUID);
        } catch (error) {
          console.warn(error);
        }
      }

      const mappedStudies = _mapDataSourceStudies(qidoStudiesForPatient);
      const actuallyMappedStudies = mappedStudies.map(qidoStudy => {
        return {
          studyInstanceUid: qidoStudy.StudyInstanceUID,
          date: formatDate(qidoStudy.StudyDate) || '',
          description: qidoStudy.StudyDescription,
          modalities: qidoStudy.ModalitiesInStudy,
          numInstances: Number(qidoStudy.NumInstances),
        };
      });

      setStudyDisplayList(prevArray => {
        const ret = [...prevArray];
        for (const study of actuallyMappedStudies) {
          if (!prevArray.find(it => it.studyInstanceUid === study.studyInstanceUid)) {
            ret.push(study);
          }
        }
        return ret;
      });
    }

    StudyInstanceUIDs.forEach(sid => fetchStudiesForPatient(sid));
  }, [StudyInstanceUIDs, dataSource, getStudiesForPatientByMRN, navigate, primaryStudyOnly]);

  // ~~ Initial Thumbnails
  useEffect(() => {
    if (!hasLoadedViewports) {
      if (activeViewportId) {
        // Once there is an active viewport id, it means the layout is ready
        // so wait a bit of time to allow the viewports preferential loading
        // which improves user experience of responsiveness significantly on slower
        // systems.
        const delayMs = 250 + displaySetService.getActiveDisplaySets().length * 10;
        window.setTimeout(() => setHasLoadedViewports(true), delayMs);
      }

      return;
    }

    let currentDisplaySets = displaySetService.activeDisplaySets;
    // filter non based on the list of modalities that are supported by cornerstone
    currentDisplaySets = currentDisplaySets.filter(
      ds => !thumbnailNoImageModalities.includes(ds.Modality) || ds.thumbnailSrc === null
    );

    if (!currentDisplaySets.length) {
      return;
    }

    const visibleThumbnailIds = new Set(visibleThumbnailDisplaySetInstanceUIDs);
    currentDisplaySets
      .filter(
        dSet => !virtualizeThumbnails || visibleThumbnailIds.has(dSet.displaySetInstanceUID)
      )
      .forEach(scheduleThumbnailLoad);
  }, [
    displaySetService,
    activeViewportId,
    hasLoadedViewports,
    scheduleThumbnailLoad,
    visibleThumbnailDisplaySetInstanceUIDs,
    virtualizeThumbnails,
  ]);

  // ~~ displaySets
  useEffect(() => {
    const currentDisplaySets = displaySetService.activeDisplaySets;

    if (!currentDisplaySets.length) {
      return;
    }

    const mappedDisplaySets = mapDisplaySetsWithState(
      currentDisplaySets,
      displaySetsLoadingState,
      thumbnailImageSrcMap,
      viewports
    );

    if (!customMapDisplaySets) {
      sortStudyInstances(mappedDisplaySets);
    }

    setDisplaySets(mergeLazyCatalogDisplaySets(mappedDisplaySets));
  }, [
    displaySetService.activeDisplaySets,
    displaySetsLoadingState,
    viewports,
    thumbnailImageSrcMap,
    customMapDisplaySets,
    mergeLazyCatalogDisplaySets,
  ]);

  // ~~ subscriptions --> displaySets
  useEffect(() => {
    // DISPLAY_SETS_ADDED returns an array of DisplaySets that were added
    const SubscriptionDisplaySetsAdded = displaySetService.subscribe(
      displaySetService.EVENTS.DISPLAY_SETS_ADDED,
      data => {
        if (!hasLoadedViewports) {
          return;
        }
        const { displaySetsAdded, options } = data;
        displaySetsAdded.forEach(dSet => {
          const displaySetInstanceUID = dSet.displaySetInstanceUID;
          const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
          if (displaySet?.unsupported) {
            return;
          }
          if (options?.madeInClient) {
            setJumpToDisplaySet(displaySetInstanceUID);
          }

          if (
            !virtualizeThumbnails ||
            visibleThumbnailDisplaySetInstanceUIDs.includes(displaySetInstanceUID)
          ) {
            scheduleThumbnailLoad(dSet);
          }
        });
      }
    );

    return () => {
      SubscriptionDisplaySetsAdded.unsubscribe();
    };
  }, [
    displaySetService,
    hasLoadedViewports,
    scheduleThumbnailLoad,
    visibleThumbnailDisplaySetInstanceUIDs,
    virtualizeThumbnails,
  ]);

  useEffect(() => {
    // TODO: Will this always hold _all_ the displaySets we care about?
    // DISPLAY_SETS_CHANGED returns `DisplaySerService.activeDisplaySets`
    const SubscriptionDisplaySetsChanged = displaySetService.subscribe(
      displaySetService.EVENTS.DISPLAY_SETS_CHANGED,
      changedDisplaySets => {
        const mappedDisplaySets = mapDisplaySetsWithState(
          changedDisplaySets,
          displaySetsLoadingState,
          thumbnailImageSrcMap,
          viewports
        );

        if (!customMapDisplaySets) {
          sortStudyInstances(mappedDisplaySets);
        }

        setDisplaySets(mergeLazyCatalogDisplaySets(mappedDisplaySets));
      }
    );

    const SubscriptionDisplaySetMetaDataInvalidated = displaySetService.subscribe(
      displaySetService.EVENTS.DISPLAY_SET_SERIES_METADATA_INVALIDATED,
      () => {
        const mappedDisplaySets = mapDisplaySetsWithState(
          displaySetService.getActiveDisplaySets(),
          displaySetsLoadingState,
          thumbnailImageSrcMap,
          viewports
        );

        if (!customMapDisplaySets) {
          sortStudyInstances(mappedDisplaySets);
        }

        setDisplaySets(mergeLazyCatalogDisplaySets(mappedDisplaySets));
      }
    );

    return () => {
      SubscriptionDisplaySetsChanged.unsubscribe();
      SubscriptionDisplaySetMetaDataInvalidated.unsubscribe();
    };
  }, [
    displaySetsLoadingState,
    thumbnailImageSrcMap,
    viewports,
    displaySetService,
    customMapDisplaySets,
    mergeLazyCatalogDisplaySets,
  ]);

  const tabs = createStudyBrowserTabs(StudyInstanceUIDs, studyDisplayList, displaySets);

  // TODO: Should not fire this on "close"
  function _handleStudyClick(StudyInstanceUID) {
    const shouldCollapseStudy = expandedStudyInstanceUIDs.includes(StudyInstanceUID);
    const updatedExpandedStudyInstanceUIDs = shouldCollapseStudy
      ? [...expandedStudyInstanceUIDs.filter(stdyUid => stdyUid !== StudyInstanceUID)]
      : [...expandedStudyInstanceUIDs, StudyInstanceUID];

    setExpandedStudyInstanceUIDs(updatedExpandedStudyInstanceUIDs);

    if (!shouldCollapseStudy) {
      const madeInClient = true;
      requestDisplaySetCreationForStudy(displaySetService, StudyInstanceUID, madeInClient);
    }
  }

  useEffect(() => {
    if (jumpToDisplaySet) {
      // Get element by displaySetInstanceUID
      const displaySetInstanceUID = jumpToDisplaySet;
      const element = document.getElementById(`thumbnail-${displaySetInstanceUID}`);

      if (element && typeof element.scrollIntoView === 'function') {
        // TODO: Any way to support IE here?
        element.scrollIntoView({ behavior: 'smooth' });

        setJumpToDisplaySet(null);
      }
    }
  }, [jumpToDisplaySet, expandedStudyInstanceUIDs, activeTabName]);

  useEffect(() => {
    if (!jumpToDisplaySet) {
      return;
    }

    const displaySetInstanceUID = jumpToDisplaySet;
    // It is possible to navigate to a study not currently in view
    const thumbnailLocation = _findTabAndStudyOfDisplaySet(
      displaySetInstanceUID,
      tabs,
      activeTabName
    );
    if (!thumbnailLocation) {
      return;
    }
    const { tabName, StudyInstanceUID } = thumbnailLocation;
    setActiveTabName(tabName);
    const studyExpanded = expandedStudyInstanceUIDs.includes(StudyInstanceUID);
    if (!studyExpanded) {
      const updatedExpandedStudyInstanceUIDs = [...expandedStudyInstanceUIDs, StudyInstanceUID];
      setExpandedStudyInstanceUIDs(updatedExpandedStudyInstanceUIDs);
    }
  }, [expandedStudyInstanceUIDs, jumpToDisplaySet, tabs]);

  const activeDisplaySetInstanceUIDs = viewports.get(activeViewportId)?.displaySetInstanceUIDs;

  return (
    <>
      <>
        <PanelStudyBrowserHeader
          viewPresets={viewPresets}
          updateViewPresetValue={updateViewPresetValue}
          actionIcons={actionIcons}
          updateActionIconValue={updateActionIconValue}
        />
        <Separator
          orientation="horizontal"
          className="bg-black"
          thickness="2px"
        />
      </>

      <StudyBrowser
        tabs={tabs}
        servicesManager={servicesManager}
        activeTabName={activeTabName}
        expandedStudyInstanceUIDs={expandedStudyInstanceUIDs}
        onClickStudy={_handleStudyClick}
        onClickTab={clickedTabName => {
          setActiveTabName(clickedTabName);
        }}
        onClickUntrack={onClickUntrack}
        onClickThumbnail={onClickThumbnailHandler}
        onDoubleClickThumbnail={onDoubleClickThumbnailHandler}
        activeDisplaySetInstanceUIDs={activeDisplaySetInstanceUIDs}
        showSettings={actionIcons.find(icon => icon.id === 'settings')?.value}
        viewPresets={viewPresets}
        ThumbnailMenuItems={MoreDropdownMenu({
          commandsManager,
          servicesManager,
          menuItemsKey: 'studyBrowser.thumbnailMenuItems',
        })}
        StudyMenuItems={MoreDropdownMenu({
          commandsManager,
          servicesManager,
          menuItemsKey: 'studyBrowser.studyMenuItems',
        })}
        virtualizeThumbnails={virtualizeThumbnails}
        onVisibleThumbnailIdsChange={onVisibleThumbnailIdsChange}
      />
    </>
  );
}

export default PanelStudyBrowser;

/**
 * Maps from the DataSource's format to a naturalized object
 *
 * @param {*} studies
 */
function _mapDataSourceStudies(studies) {
  return studies.map(study => {
    // TODO: Why does the data source return in this format?
    return {
      AccessionNumber: study.accession,
      StudyDate: study.date,
      StudyDescription: study.description,
      NumInstances: study.instances,
      ModalitiesInStudy: study.modalities,
      PatientID: study.mrn,
      PatientName: study.patientName,
      StudyInstanceUID: study.studyInstanceUid,
      StudyTime: study.time,
    };
  });
}

function _mapDisplaySets(displaySets, displaySetLoadingState, thumbnailImageSrcMap, viewports) {
  const thumbnailDisplaySets = [];
  const thumbnailNoImageDisplaySets = [];
  displaySets
    .filter(ds => !ds.excludeFromThumbnailBrowser)
    .forEach(ds => {
      const { thumbnailSrc, displaySetInstanceUID } = ds;
      const componentType = _getComponentType(ds);

      const array =
        componentType === 'thumbnail' ? thumbnailDisplaySets : thumbnailNoImageDisplaySets;

      const loadingProgress = displaySetLoadingState?.[displaySetInstanceUID];

      array.push({
        displaySetInstanceUID,
        description: ds.SeriesDescription || '',
        seriesNumber: ds.SeriesNumber,
        modality: ds.Modality,
        seriesDate: formatDate(ds.SeriesDate),
        numInstances: ds.numImageFrames ?? ds.instances?.length,
        loadingProgress,
        countIcon: ds.countIcon,
        messages: ds.messages,
        StudyInstanceUID: ds.StudyInstanceUID,
        componentType,
        imageSrc: thumbnailSrc || thumbnailImageSrcMap[displaySetInstanceUID],
        dragData: {
          type: 'displayset',
          displaySetInstanceUID,
          // .. Any other data to pass
        },
        isHydratedForDerivedDisplaySet: ds.isHydrated,
      });
    });

  return [...thumbnailDisplaySets, ...thumbnailNoImageDisplaySets];
}

function _getComponentType(ds) {
  if (
    thumbnailNoImageModalities.includes(ds.Modality) ||
    ds?.unsupported ||
    ds.thumbnailSrc === null
  ) {
    return 'thumbnailNoImage';
  }

  return 'thumbnail';
}

function getImageIdForThumbnail(displaySet, imageIds) {
  let imageId;
  if (displaySet.isDynamicVolume) {
    const timePoints = displaySet.dynamicVolumeInfo.timePoints;
    const middleIndex = Math.floor(timePoints.length / 2);
    const middleTimePointImageIds = timePoints[middleIndex];
    imageId = middleTimePointImageIds[Math.floor(middleTimePointImageIds.length / 2)];
  } else {
    imageId = imageIds[Math.floor(imageIds.length / 2)];
  }
  return imageId;
}

function _findTabAndStudyOfDisplaySet(
  displaySetInstanceUID: string,
  tabs: TabsProps,
  currentTabName: string
) {
  const current = tabs.find(tab => tab.name === currentTabName) || tabs[0];
  const biasedTabs = [current, ...tabs];

  for (let t = 0; t < biasedTabs.length; t++) {
    const study = biasedTabs[t].studies.find(study =>
      study.displaySets.find(ds => ds.displaySetInstanceUID === displaySetInstanceUID)
    );
    if (study) {
      return {
        tabName: biasedTabs[t].name,
        StudyInstanceUID: study.studyInstanceUid,
      };
    }
  }
}
