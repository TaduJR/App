import type {SearchListItem} from '@components/Search/SearchList/ListItem/types';
import type {SearchData, SearchQueryJSON, SelectedTransactions} from '@components/Search/types';

import {search} from '@libs/actions/Search';
import Log from '@libs/Log';
import type {SearchKey} from '@libs/SearchUIUtils';
import {isTransactionGroupListItemType} from '@libs/SearchUIUtils';

import CONST from '@src/CONST';
import {isEmptyObject} from '@src/types/utils/EmptyObject';

import {useEffect, useEffectEvent, useRef, useState} from 'react';

/**
 * Paging for a to-do search, whose rows come from Onyx: how many of the device's rows render, and which server page is
 * still owed. Online, rows wait for their page, as on any other search. The hook keeps its own cursor because the
 * snapshot's `offset` and `isLoading` are shared by every caller of `search()`. `hasMoreResults` is shared too, so
 * another caller's answer can cost an extra page.
 */

type LiveSearchPagingParams = {
    queryJSON: Readonly<SearchQueryJSON>;

    searchKey: SearchKey | undefined;

    /** When false (a snapshot search), the rows pass through and nothing is requested. */
    isLiveSearch: boolean;

    hasMoreServerResults: boolean;

    isOffline: boolean;

    isFocused: boolean;

    shouldCalculateTotalsOnFirstPage: boolean;

    shouldCalculateTotalsOnLaterPages: boolean;

    /** Whether Search holds its rows back while the screen settles, which leaves the list empty. */
    areRowsDeferred: boolean;

    /** Every row the search matches on the device, in render order. */
    deviceRows: SearchListItem[];

    deviceFilteredData: SearchData;

    selectedTransactions: SelectedTransactions;
};

type LiveSearchPagingResult = {
    visibleRows: SearchListItem[];

    /** `visibleRows` as selection takes them, so a bulk action never reaches a row that isn't rendered. */
    visibleFilteredData: SearchData;

    loadMoreRows: () => void;

    isLoadingMore: boolean;

    /** The offset of the last page the server answered, not the last one asked for. */
    lastPageOffset: number;
};

type RequestedRows = {
    rows: number;

    /** Rows the server has been asked to cover. */
    serverRows: number;
};

const PAGE_SIZE: number = CONST.SEARCH.RESULTS_PAGE_SIZE;

function getRowCountKeepingRowsInView(rows: SearchListItem[], rowLimit: number, selectedTransactions: SelectedTransactions, isRowShown: (row: SearchListItem) => boolean): number {
    const hasSelection = !isEmptyObject(selectedTransactions);
    const isKeySelected = (key: string) => !!selectedTransactions[key]?.isSelected;
    // A report counts as selected through its expenses, as the page checkbox counts it.
    const isRowSelected = (row: SearchListItem) =>
        isKeySelected(row.keyForList) || (isTransactionGroupListItemType(row) && row.transactions.some((transaction) => isKeySelected(transaction.keyForList)));
    let shownRowCount = 0;
    let rowCountInView = rowLimit;
    for (const row of rows) {
        if (!isRowShown(row)) {
            continue;
        }
        shownRowCount += 1;
        if (shownRowCount > rowLimit && (!!row.shouldAnimateInHighlight || (hasSelection && isRowSelected(row)))) {
            rowCountInView = shownRowCount;
        }
    }
    return rowCountInView;
}

function getLeadingRows(rows: SearchListItem[], rowLimit: number, isRowShown: (row: SearchListItem) => boolean): SearchListItem[] {
    let shownRowCount = 0;
    for (const [index, row] of rows.entries()) {
        if (!isRowShown(row)) {
            continue;
        }
        if (shownRowCount === rowLimit) {
            return rows.slice(0, index);
        }
        shownRowCount += 1;
    }
    return rows;
}

function useLiveSearchPaging({
    queryJSON,
    searchKey,
    isLiveSearch,
    hasMoreServerResults,
    isOffline,
    isFocused,
    shouldCalculateTotalsOnFirstPage,
    shouldCalculateTotalsOnLaterPages,
    areRowsDeferred,
    deviceRows,
    deviceFilteredData,
    selectedTransactions,
}: LiveSearchPagingParams): LiveSearchPagingResult {
    const [requested, setRequested] = useState<RequestedRows>({rows: PAGE_SIZE, serverRows: PAGE_SIZE});

    // Advances only on an answer, so a page is never skipped.
    const [nextPageToFetch, setNextPageToFetch] = useState(0);

    const [isRetryBlocked, setIsRetryBlocked] = useState(false);

    // Counts rather than a flag, so an answer settles only the refreshes owed when its request went out.
    const [refreshesOwed, setRefreshesOwed] = useState(0);
    const [refreshesSettled, setRefreshesSettled] = useState(0);

    const [wasOffline, setWasOffline] = useState(isOffline);
    const [wasFocused, setWasFocused] = useState(isFocused);
    const [didLaterPagesNeedTotals, setDidLaterPagesNeedTotals] = useState(shouldCalculateTotalsOnLaterPages);
    // Skipped for snapshot searches, since each update here renders all of Search again.
    if (isLiveSearch && (wasOffline !== isOffline || wasFocused !== isFocused || didLaterPagesNeedTotals !== shouldCalculateTotalsOnLaterPages)) {
        setWasOffline(isOffline);
        setWasFocused(isFocused);
        setDidLaterPagesNeedTotals(shouldCalculateTotalsOnLaterPages);
        const hasReconnected = wasOffline && !isOffline;
        if (hasReconnected || (isFocused && !wasFocused)) {
            setIsRetryBlocked(false);
        }
        // Live changes can leave page 0's totals stale, so it is asked again too.
        const doLaterPagesNowNeedTotals = shouldCalculateTotalsOnLaterPages && !didLaterPagesNeedTotals;
        if (nextPageToFetch > 0 && (hasReconnected || doLaterPagesNowNeedTotals)) {
            setRefreshesOwed((count) => count + 1);
        }
    }

    // Until a page answers, `hasMoreServerResults` may be stale.
    const hasLoadedAnyPage = nextPageToFetch > 0;
    const canServerHaveMore = hasMoreServerResults || !hasLoadedAnyPage;
    // A kept row or an offline session can show rows the server wasn't asked for.
    const isAheadOfServer = requested.rows > requested.serverRows;
    const canShowDeviceRows = isOffline || isRetryBlocked || isAheadOfServer;
    const pagedRows = canShowDeviceRows ? requested.rows : Math.min(requested.rows, Math.max(PAGE_SIZE, nextPageToFetch));

    // Offline, a row being deleted still shows, struck through.
    const isRowShown = (row: SearchListItem) => isOffline || row.pendingAction !== CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE;
    const shownRowCount = isLiveSearch ? deviceRows.filter(isRowShown).length : deviceRows.length;
    // With nothing left to page, every row shows, so select all reaches them all.
    const targetRows = canServerHaveMore ? pagedRows : shownRowCount;
    // Selection only holds rendered rows, and a new expense is scrolled to only once rendered.
    const rowsInView = isLiveSearch ? getRowCountKeepingRowsInView(deviceRows, targetRows, selectedTransactions, isRowShown) : targetRows;

    // Never shrinks, so rows don't vanish when a tick clears, a highlight ends or the connection returns.
    const [renderedRows, setRenderedRows] = useState(rowsInView);
    const [previousRowsInView, setPreviousRowsInView] = useState(rowsInView);
    if (previousRowsInView !== rowsInView) {
        setPreviousRowsInView(rowsInView);
        setRenderedRows((rows) => Math.max(rows, rowsInView));
    }
    const rowLimit = Math.max(renderedRows, rowsInView);

    const isRowLimitApplied = isLiveSearch && shownRowCount > rowLimit;
    const visibleRows = isRowLimitApplied ? getLeadingRows(deviceRows, rowLimit, isRowShown) : deviceRows;
    // A to-do search lists expense reports only.
    const visibleFilteredData = isRowLimitApplied ? visibleRows.filter(isTransactionGroupListItemType) : deviceFilteredData;

    // Rows the device lacks are fetched page by page from the cursor, since skipping an offset page can skip reports. Deferred rows only look missing.
    const isDeviceShort = !areRowsDeferred && shownRowCount < requested.rows;
    const serverRowsOwed = isDeviceShort ? Math.max(requested.serverRows, requested.rows) : requested.serverRows;
    const isPageOwed = isLiveSearch && nextPageToFetch < serverRowsOwed && canServerHaveMore && !isRetryBlocked;
    const lastPageOffset = Math.max(0, nextPageToFetch - PAGE_SIZE);
    const isRequestInFlightRef = useRef(false);
    const lastCountedEndRef = useRef<{renderedRowCount: number; wasRetry: boolean} | undefined>(undefined);

    // Answers merge with `Math.max`, so a late answer, or one landing while the list is hidden, never undoes a newer one.
    const requestPage = useEffectEvent((offset: number) => {
        const shouldCalculateTotals = offset === 0 ? shouldCalculateTotalsOnFirstPage : shouldCalculateTotalsOnLaterPages;
        const refreshesOwedAtSend = refreshesOwed;
        const recordAnswer = (jsonCode: string | number | undefined) => {
            // Cleared before the answer's update, so the render it causes can send the next page.
            isRequestInFlightRef.current = false;
            // `search()` also returns nothing when a delete drops the page or the same page is already in flight, and both count as failed.
            if (jsonCode !== CONST.JSON_CODE.SUCCESS) {
                setIsRetryBlocked(true);
                return;
            }
            setRefreshesSettled((count) => Math.max(count, refreshesOwedAtSend));
            setNextPageToFetch((page) => Math.max(page, offset + PAGE_SIZE));
        };
        // Inside a promise, so a `search()` that throws counts as a failed page instead of escaping the Effect.
        const request = new Promise<string | number | undefined>((resolve) => {
            resolve(search({queryJSON, searchKey, offset, shouldCalculateTotals, isLoading: false}));
        });
        isRequestInFlightRef.current = true;
        request.then(recordAnswer, (error: unknown) => {
            Log.hmmm('[Search] A to-do page request threw', {error: String(error)});
            recordAnswer(undefined);
        });
    });

    useEffect(() => {
        if (!isLiveSearch || !isFocused || isOffline || isRequestInFlightRef.current) {
            return;
        }
        if (isPageOwed) {
            requestPage(nextPageToFetch);
            return;
        }
        // Both counts are dependencies, so settling one refresh while another is owed still runs this again.
        if (refreshesOwed > refreshesSettled && !isRetryBlocked) {
            requestPage(lastPageOffset);
        }
    }, [isLiveSearch, isPageOwed, refreshesOwed, refreshesSettled, isRetryBlocked, isFocused, isOffline, nextPageToFetch, lastPageOffset]);

    function loadMoreRows() {
        if (!isLiveSearch || !isFocused || areRowsDeferred) {
            return;
        }

        const wasRetryBlocked = isRetryBlocked;
        // FlashList reports an end for every new rows array, so an end counts only once the rendered rows change, and a failed page is retried once per set of rows.
        const renderedRowCount = Math.min(rowLimit, shownRowCount);
        const lastCountedEnd = lastCountedEndRef.current;
        if (renderedRowCount === lastCountedEnd?.renderedRowCount && (!wasRetryBlocked || lastCountedEnd.wasRetry)) {
            return;
        }
        // From what is on screen, so a list widened by a kept row still grows at its end.
        const askedRows = Math.max(requested.rows, rowLimit);
        const isRequestCovered = Math.min(shownRowCount, rowLimit) >= askedRows || (!wasRetryBlocked && nextPageToFetch + PAGE_SIZE >= askedRows);
        const canShowMore = shownRowCount > askedRows || canServerHaveMore;
        const shouldGrow = isRequestCovered && canShowMore;
        // Not remembered, so the same rows count again once the server has more.
        if (!shouldGrow && !wasRetryBlocked) {
            return;
        }
        lastCountedEndRef.current = {renderedRowCount, wasRetry: wasRetryBlocked};
        setIsRetryBlocked(false);
        if (!shouldGrow) {
            return;
        }
        const serverRows = isOffline ? requested.serverRows : Math.max(requested.serverRows, nextPageToFetch) + PAGE_SIZE;
        setRequested({rows: askedRows + PAGE_SIZE, serverRows});
    }

    return {
        visibleRows,
        visibleFilteredData,
        loadMoreRows,
        // No footer before an end of the list, since the first rows render at once.
        isLoadingMore: isPageOwed && isFocused && !isOffline && !areRowsDeferred && requested.rows > PAGE_SIZE && requested.rows > Math.min(rowLimit, shownRowCount),
        lastPageOffset,
    };
}

export default useLiveSearchPaging;
