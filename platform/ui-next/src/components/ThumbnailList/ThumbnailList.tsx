import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

import { Thumbnail } from '../Thumbnail';
import { useDynamicMaxHeight } from '../../hooks/useDynamicMaxHeight';

const ThumbnailList = ({
  thumbnails,
  onThumbnailClick,
  onThumbnailDoubleClick,
  onClickUntrack,
  activeDisplaySetInstanceUIDs = [],
  viewPreset,
  ThumbnailMenuItems,
  virtualize = false,
  onVisibleThumbnailIdsChange,
}) => {
  // Use the dynamic height hook on the parent container
  const { ref, maxHeight } = useDynamicMaxHeight(thumbnails);

  // Filter thumbnails into list items and thumbnail items
  const listItems = useMemo(
    () =>
      thumbnails?.filter(
        ({ componentType }) => componentType === 'thumbnailNoImage' || viewPreset === 'list'
      ) || [],
    [thumbnails, viewPreset]
  );

  const thumbnailItems = useMemo(
    () =>
      thumbnails?.filter(
        ({ componentType }) => componentType !== 'thumbnailNoImage' && viewPreset === 'thumbnails'
      ) || [],
    [thumbnails, viewPreset]
  );

  const virtualListRef = useRef<HTMLDivElement>(null);
  const [virtualLayout, setVirtualLayout] = useState({
    columns: 1,
    startIndex: 0,
    endIndex: 0,
  });

  useEffect(() => {
    if (!virtualize || viewPreset !== 'thumbnails') {
      onVisibleThumbnailIdsChange?.(thumbnailItems.map(item => item.displaySetInstanceUID));
      return;
    }

    const element = virtualListRef.current;
    if (!element) {
      return;
    }

    const itemWidth = 135;
    const itemHeight = 170;
    const gap = 4;
    const overscanRows = 3;
    const scrollViewport = element.closest('[data-radix-scroll-area-viewport]') as HTMLElement;

    const updateVisibleRange = () => {
      const width = element.clientWidth;
      const columns = Math.max(1, Math.floor((width + gap) / (itemWidth + gap)));
      const elementRect = element.getBoundingClientRect();
      const viewportRect = scrollViewport?.getBoundingClientRect();
      const visibleTop = Math.max(0, (viewportRect?.top ?? 0) - elementRect.top);
      const visibleBottom = Math.min(
        Math.ceil(thumbnailItems.length / columns) * (itemHeight + gap),
        (viewportRect?.bottom ?? window.innerHeight) - elementRect.top
      );
      const startRow = Math.max(0, Math.floor(visibleTop / (itemHeight + gap)) - overscanRows);
      const endRow = Math.min(
        Math.ceil(thumbnailItems.length / columns),
        Math.ceil(visibleBottom / (itemHeight + gap)) + overscanRows
      );
      const startIndex = startRow * columns;
      const endIndex = Math.min(thumbnailItems.length, endRow * columns);

      setVirtualLayout(previous => {
        if (
          previous.columns === columns &&
          previous.startIndex === startIndex &&
          previous.endIndex === endIndex
        ) {
          return previous;
        }
        return { columns, startIndex, endIndex };
      });
    };

    const resizeObserver = new ResizeObserver(updateVisibleRange);
    resizeObserver.observe(element);
    scrollViewport?.addEventListener('scroll', updateVisibleRange, { passive: true });
    window.addEventListener('resize', updateVisibleRange);
    updateVisibleRange();

    return () => {
      resizeObserver.disconnect();
      scrollViewport?.removeEventListener('scroll', updateVisibleRange);
      window.removeEventListener('resize', updateVisibleRange);
    };
  }, [virtualize, viewPreset, thumbnailItems, onVisibleThumbnailIdsChange]);

  useEffect(() => {
    if (!virtualize || viewPreset !== 'thumbnails') {
      return;
    }

    onVisibleThumbnailIdsChange?.(
      thumbnailItems
        .slice(virtualLayout.startIndex, virtualLayout.endIndex)
        .map(item => item.displaySetInstanceUID)
    );
  }, [
    virtualize,
    viewPreset,
    thumbnailItems,
    virtualLayout.startIndex,
    virtualLayout.endIndex,
    onVisibleThumbnailIdsChange,
  ]);

  const renderThumbnail = (item, style = undefined) => {
    const { displaySetInstanceUID, componentType, numInstances, ...rest } = item;
    const isActive = activeDisplaySetInstanceUIDs.includes(displaySetInstanceUID);

    return (
      <div
        key={displaySetInstanceUID}
        style={style}
      >
        <Thumbnail
          {...rest}
          displaySetInstanceUID={displaySetInstanceUID}
          numInstances={numInstances || 1}
          isActive={isActive}
          thumbnailType={componentType}
          viewPreset="thumbnails"
          onClick={onThumbnailClick.bind(null, displaySetInstanceUID)}
          onDoubleClick={onThumbnailDoubleClick.bind(null, displaySetInstanceUID)}
          onClickUntrack={onClickUntrack.bind(null, displaySetInstanceUID)}
          ThumbnailMenuItems={ThumbnailMenuItems}
        />
      </div>
    );
  };

  return (
    <div className="flex flex-col">
      <div
        ref={ref}
        className="flex flex-col gap-[2px] pt-[4px] pr-[2.5px] pl-[5px] pb-[4px]"
      >
        {thumbnailItems.length > 0 && (
          <div
            ref={virtualListRef}
            id="ohif-thumbnail-list"
            className={
              virtualize
                ? 'bg-bkg-low relative'
                : 'bg-bkg-low grid grid-cols-[repeat(auto-fit,_minmax(0,135px))] place-items-start gap-[4px]'
            }
            style={
              virtualize
                ? {
                    minHeight: `${Math.ceil(thumbnailItems.length / virtualLayout.columns) * 174}px`,
                  }
                : undefined
            }
          >
            {virtualize
              ? thumbnailItems
                  .slice(virtualLayout.startIndex, virtualLayout.endIndex)
                  .map((item, offset) => {
                    const index = virtualLayout.startIndex + offset;
                    const column = index % virtualLayout.columns;
                    const row = Math.floor(index / virtualLayout.columns);
                    return renderThumbnail(item, {
                      position: 'absolute',
                      left: `${column * 139}px`,
                      top: `${row * 174}px`,
                    });
                  })
              : thumbnailItems.map(item => renderThumbnail(item))}
          </div>
        )}
        {/* List Items */}
        {listItems.length > 0 && (
          <div
            id="ohif-thumbnail-list"
            className="bg-bkg-low grid grid-cols-[repeat(auto-fit,_minmax(0,275px))] place-items-start gap-[2px]"
          >
            {listItems.map(item => {
              const { displaySetInstanceUID, componentType, numInstances, ...rest } = item;
              const isActive = activeDisplaySetInstanceUIDs.includes(displaySetInstanceUID);
              return (
                <Thumbnail
                  key={displaySetInstanceUID}
                  {...rest}
                  displaySetInstanceUID={displaySetInstanceUID}
                  numInstances={numInstances || 1}
                  isActive={isActive}
                  thumbnailType={componentType}
                  viewPreset="list"
                  onClick={onThumbnailClick.bind(null, displaySetInstanceUID)}
                  onDoubleClick={onThumbnailDoubleClick.bind(null, displaySetInstanceUID)}
                  onClickUntrack={onClickUntrack.bind(null, displaySetInstanceUID)}
                  ThumbnailMenuItems={ThumbnailMenuItems}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

ThumbnailList.propTypes = {
  thumbnails: PropTypes.arrayOf(
    PropTypes.shape({
      displaySetInstanceUID: PropTypes.string.isRequired,
      imageSrc: PropTypes.string,
      imageAltText: PropTypes.string,
      seriesDate: PropTypes.string,
      seriesNumber: PropTypes.any,
      numInstances: PropTypes.number,
      description: PropTypes.string,
      componentType: PropTypes.any,
      isTracked: PropTypes.bool,
      /**
       * Data the thumbnail should expose to a receiving drop target. Use a matching
       * `dragData.type` to identify which targets can receive this draggable item.
       * If this is not set, drag-n-drop will be disabled for this thumbnail.
       *
       * Ref: https://react-dnd.github.io/react-dnd/docs/api/use-drag#specification-object-members
       */
      dragData: PropTypes.shape({
        /** Must match the "type" a dropTarget expects */
        type: PropTypes.string.isRequired,
      }),
    })
  ),
  activeDisplaySetInstanceUIDs: PropTypes.arrayOf(PropTypes.string),
  onThumbnailClick: PropTypes.func.isRequired,
  onThumbnailDoubleClick: PropTypes.func.isRequired,
  onClickUntrack: PropTypes.func.isRequired,
  viewPreset: PropTypes.string,
  ThumbnailMenuItems: PropTypes.any,
  virtualize: PropTypes.bool,
  onVisibleThumbnailIdsChange: PropTypes.func,
};

export { ThumbnailList };
