import type {SearchListItem} from '@components/Search/SearchList/ListItem/types';
import type {SearchData, SearchQueryJSON, SelectedTransactions} from '@components/Search/types';

import useOnyx from '@hooks/useOnyx';

import {search} from '@libs/actions/Search';
import Log from '@libs/Log';
import type {SearchKey} from '@libs/SearchKeyUtils';
import {isTransactionGroupListItemType} from '@libs/SearchUIUtils';

import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import type {SearchResults} from '@src/types/onyx';
import {isEmptyObject} from '@src/types/utils/EmptyObject';

import type {OnyxEntry} from 'react-native-onyx';

import {useEffect, useEffectEvent, useRef, useState} from 'react';

/**
 * Paging for a to-do search, whose rows come from Onyx: how many of the device's rows render, and which page is still
 * owed. Rows wait for their page, offline included, as on any other search. The cursor is inherited from the shared
 * snapshot at mount, a page already running included, and owned from the first request onwards, because every caller of
 * `search()` writes that snapshot: a refresh rewinds it and report navigation pushes it forward.
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

    /** In the order they render. */
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

type SharedPage = {
    hash: number | undefined;
    offset: number | undefined;
    isInFlight: boolean;
    didFail: boolean;
};

type InheritedPage = {
    /** Rows the shared snapshot has already been given for this query. */
    rows: number;

    /** The page that was already running when this hook mounted, which it waits for instead of sending its own. */
    inFlightOffset: number | undefined;
};

const PAGE_SIZE: number = CONST.SEARCH.RESULTS_PAGE_SIZE;

const EMPTY_INHERITED_PAGE: InheritedPage = {rows: 0, inFlightOffset: undefined};

function getSharedPage(snapshot: OnyxEntry<SearchResults>): SharedPage {
    return {
        hash: snapshot?.search?.hash,
        offset: snapshot?.search?.offset,
        isInFlight: snapshot?.search?.state === CONST.SEARCH.SNAPSHOT_STATE.LOADING,
        didFail: typeof snapshot?.search?.responseJsonCode === 'number',
    };
}

function getInheritedPage(sharedPage: SharedPage | undefined, hash: number): InheritedPage {
    // A snapshot carries its hash only once an answer has landed in it, so anything else has delivered no rows.
    if (!sharedPage || sharedPage.hash !== hash) {
        return EMPTY_INHERITED_PAGE;
    }
    // The cursor is written when a request goes out, so a page still running, or one that failed, delivered nothing.
    const cursor = Math.max(0, sharedPage.offset ?? 0);
    if (sharedPage.isInFlight) {
        return {rows: cursor, inFlightOffset: cursor};
    }
    return {rows: sharedPage.didFail ? cursor : cursor + PAGE_SIZE, inFlightOffset: undefined};
}

function getRowCountKeepingRowsInView(rows: SearchListItem[], rowLimit: number, selectedTransactions: SelectedTransactions, isRowShown: (row: SearchListItem) => boolean): number {
    const hasSelection = !isEmptyObject(selectedTransactions);
    const isKeySelected = (key: string) => !!selectedTransactions[key]?.isSelected;
    // Matches how the page checkbox counts a report as selected.
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
    // Read here, not taken from the object Search holds, because the inheritance needs to know when the key has loaded.
    const [sharedPage, sharedPageResult] = useOnyx(`${ONYXKEYS.COLLECTION.SNAPSHOT}${queryJSON.hash}`, {selector: getSharedPage});

    const [requested, setRequested] = useState<RequestedRows>({rows: PAGE_SIZE, serverRows: PAGE_SIZE});

    // Advances only on an answer, so a page is never skipped.
    const [nextPageToFetch, setNextPageToFetch] = useState(0);

    const [isRetryBlocked, setIsRetryBlocked] = useState(false);

    /** What the shared snapshot had achieved when this hook mounted. Undefined until the snapshot key has loaded. */
    const [inherited, setInherited] = useState<InheritedPage | undefined>(undefined);

    /** A page another caller is running, which this hook waits for instead of sending one `search()` would drop. */
    const [adoptedOffset, setAdoptedOffset] = useState<number | undefined>(undefined);

    // Kept apart from the cursor, so a `hasMoreResults` inherited from an earlier session cannot reveal every device row.
    const [hasAnsweredSinceMount, setHasAnsweredSinceMount] = useState(false);

    // Rises each time paging is re-armed, by a reconnect or a return to the screen. An answer from before that decides nothing.
    const [pagingEpoch, setPagingEpoch] = useState(0);

    // Taken once, on the first render where the key is loaded, so a warm cursor costs no request at all.
    if (isLiveSearch && !inherited && sharedPageResult.status === 'loaded') {
        const inheritedPage = getInheritedPage(sharedPage, queryJSON.hash);
        setInherited(inheritedPage);
        setAdoptedOffset(inheritedPage.inFlightOffset);
        if (inheritedPage.rows > 0) {
            setNextPageToFetch((page) => Math.max(page, inheritedPage.rows));
            setRequested((rows) => ({rows: Math.max(rows.rows, inheritedPage.rows), serverRows: Math.max(rows.serverRows, inheritedPage.rows)}));
        }
    }
    const isAdoptedPageInFlight = adoptedOffset !== undefined;

    // A page another caller is running answers into the same rows, so its result is taken as if this hook had sent it.
    if (isLiveSearch && adoptedOffset !== undefined && !sharedPage?.isInFlight) {
        setAdoptedOffset(undefined);
        if (sharedPage?.didFail) {
            setIsRetryBlocked(true);
        } else {
            setHasAnsweredSinceMount(true);
            setNextPageToFetch((page) => Math.max(page, adoptedOffset + PAGE_SIZE));
        }
    }

    // Counts rather than a flag, so an answer settles only the refreshes owed when its request went out.
    const [refreshesOwed, setRefreshesOwed] = useState(0);
    const [refreshesSettled, setRefreshesSettled] = useState(0);

    const [wasOffline, setWasOffline] = useState(isOffline);
    const [wasFocused, setWasFocused] = useState(isFocused);
    const [didLaterPagesNeedTotals, setDidLaterPagesNeedTotals] = useState(shouldCalculateTotalsOnLaterPages);
    // Each update here renders all of Search again.
    if (isLiveSearch && (wasOffline !== isOffline || wasFocused !== isFocused || didLaterPagesNeedTotals !== shouldCalculateTotalsOnLaterPages)) {
        setWasOffline(isOffline);
        setWasFocused(isFocused);
        setDidLaterPagesNeedTotals(shouldCalculateTotalsOnLaterPages);
        const hasReconnected = wasOffline && !isOffline;
        const isPagingRearmed = hasReconnected || (isFocused && !wasFocused);
        if (isPagingRearmed) {
            setIsRetryBlocked(false);
            setPagingEpoch((epoch) => epoch + 1);
        }
        // Live changes can leave page 0's totals stale, so it is asked again too.
        const doLaterPagesNowNeedTotals = shouldCalculateTotalsOnLaterPages && !didLaterPagesNeedTotals;
        if (nextPageToFetch > 0 && (hasReconnected || doLaterPagesNowNeedTotals)) {
            setRefreshesOwed((count) => count + 1);
        }
    }

    // Until a page answers in this mount, `hasMoreServerResults` may be stale, an inherited one most of all.
    const canServerHaveMore = hasMoreServerResults || !hasAnsweredSinceMount;
    const isAheadOfServer = requested.rows > requested.serverRows;
    const pagedRows = isAheadOfServer ? requested.rows : Math.min(requested.rows, Math.max(PAGE_SIZE, nextPageToFetch));

    // Offline, a row being deleted still shows, struck through.
    const isRowShown = (row: SearchListItem) => isOffline || row.pendingAction !== CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE;
    const shownRowCount = isLiveSearch ? deviceRows.filter(isRowShown).length : deviceRows.length;
    // Once nothing is left to page, every row shows, so a bulk action can't miss one.
    const targetRows = canServerHaveMore ? pagedRows : shownRowCount;
    // A ticked row that stops rendering loses its tick, and a new expense is scrolled to only once rendered.
    const rowsInView = isLiveSearch ? getRowCountKeepingRowsInView(deviceRows, targetRows, selectedTransactions, isRowShown) : targetRows;

    // So rows don't vanish when a tick clears or a highlight ends.
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

    // Skipping an offset page can skip reports, so the cursor walks them in order. Deferred rows only look missing.
    const isDeviceShort = !areRowsDeferred && shownRowCount < requested.rows;
    const serverRowsOwed = isDeviceShort ? Math.max(requested.serverRows, requested.rows) : requested.serverRows;
    const isPageOwed = isLiveSearch && nextPageToFetch < serverRowsOwed && canServerHaveMore && !isRetryBlocked;
    const lastPageOffset = Math.max(0, nextPageToFetch - PAGE_SIZE);
    const isRequestInFlightRef = useRef(false);
    const lastCountedEndRef = useRef<number | undefined>(undefined);
    const pagingEpochRef = useRef(pagingEpoch);
    const adoptedEndsRef = useRef(0);
    const sharedPageRef = useRef(sharedPage);
    useEffect(() => {
        sharedPageRef.current = sharedPage;
    }, [sharedPage]);

    // Whatever was in flight belongs to an epoch that is over, so it can neither block paging nor hold it open.
    useEffect(() => {
        if (pagingEpochRef.current === pagingEpoch) {
            return;
        }
        pagingEpochRef.current = pagingEpoch;
        isRequestInFlightRef.current = false;
    }, [pagingEpoch]);

    // Answers merge with `Math.max`, so a late answer, or one landing while the list is hidden, never undoes a newer one.
    const requestPage = useEffectEvent((offset: number) => {
        const shouldCalculateTotals = offset === 0 ? shouldCalculateTotalsOnFirstPage : shouldCalculateTotalsOnLaterPages;
        const refreshesOwedAtSend = refreshesOwed;
        const epochAtSend = pagingEpochRef.current;
        const recordAnswer = (jsonCode: string | number | undefined) => {
            const isFromCurrentEpoch = epochAtSend === pagingEpochRef.current;
            if (isFromCurrentEpoch) {
                // Cleared before the answer's update, so the render it causes can send the next page.
                isRequestInFlightRef.current = false;
            }
            // `search()` also returns nothing when a delete drops the page or the same page is already in flight.
            if (jsonCode !== CONST.JSON_CODE.SUCCESS) {
                // A failure from before paging was re-armed would block the attempt the user is waiting on now.
                if (!isFromCurrentEpoch) {
                    return;
                }
                // The snapshot still showing this page as out is the one sign that it was dropped as a duplicate, not lost.
                if (sharedPageRef.current?.isInFlight && sharedPageRef.current?.offset === offset) {
                    setAdoptedOffset(offset);
                    return;
                }
                // Forgotten, so the next end of the list retries the page, which the rows alone could never ask for again.
                lastCountedEndRef.current = undefined;
                setIsRetryBlocked(true);
                return;
            }
            setHasAnsweredSinceMount(true);
            setRefreshesSettled((count) => Math.max(count, refreshesOwedAtSend));
            setNextPageToFetch((page) => Math.max(page, offset + PAGE_SIZE));
        };
        // Inside a promise, so a `search()` that throws counts as a failed page instead of escaping the Effect.
        isRequestInFlightRef.current = true;
        const request = new Promise<string | number | undefined>((resolve) => {
            resolve(search({queryJSON, searchKey, offset, shouldCalculateTotals, isLoading: false}));
        });
        request.then(recordAnswer, (error: unknown) => {
            Log.hmmm('[Search] A to-do page request threw', {error: String(error)});
            recordAnswer(undefined);
        });
    });

    useEffect(() => {
        // Nothing is asked for before the inheritance is settled, or while the page it inherited is still out.
        if (!isLiveSearch || !inherited || isAdoptedPageInFlight || !isFocused || isOffline || isRequestInFlightRef.current) {
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
    }, [isLiveSearch, inherited, isAdoptedPageInFlight, isPageOwed, refreshesOwed, refreshesSettled, isRetryBlocked, isFocused, isOffline, nextPageToFetch, lastPageOffset]);

    function loadMoreRows() {
        if (!isLiveSearch || !isFocused || areRowsDeferred || !inherited) {
            return;
        }

        // A page left out by a reload never settles, so it is waited for until a second end says the user still is.
        if (isAdoptedPageInFlight) {
            if (adoptedEndsRef.current > 0) {
                setAdoptedOffset(undefined);
            }
            adoptedEndsRef.current += 1;
        }

        // FlashList reports an end for every new rows array, so an end counts only once the rendered rows change.
        const renderedRowCount = Math.min(rowLimit, shownRowCount);
        if (renderedRowCount === lastCountedEndRef.current) {
            return;
        }
        // From what is on screen, so a list widened by a kept row still grows at its end.
        const askedRows = Math.max(requested.rows, rowLimit);
        const isRequestCovered = Math.min(shownRowCount, rowLimit) >= askedRows || (!isRetryBlocked && nextPageToFetch + PAGE_SIZE >= askedRows);
        const canShowMore = shownRowCount > askedRows || canServerHaveMore;
        const shouldGrow = isRequestCovered && canShowMore;
        // Not remembered, so the same rows count again once the server has more.
        if (!shouldGrow && !isRetryBlocked) {
            return;
        }
        lastCountedEndRef.current = renderedRowCount;
        setIsRetryBlocked(false);
        if (!shouldGrow) {
            return;
        }
        // Owed even offline, so the page the user reached the end for goes out on reconnect.
        const serverRows = Math.max(requested.serverRows, nextPageToFetch) + PAGE_SIZE;
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
