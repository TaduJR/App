import {act, renderHook, waitFor} from '@testing-library/react-native';

import useLiveSearchPaging from '@components/Search/hooks/useLiveSearchPaging';
import type {SelectedTransactionInfo, SelectedTransactions} from '@components/Search/types';

import {search} from '@libs/actions/Search';
import {buildSearchQueryJSON} from '@libs/SearchQueryUtils';

import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import type {SearchResults} from '@src/types/onyx';

import type {ReactNode} from 'react';

import React, {Activity, StrictMode} from 'react';
import Onyx from 'react-native-onyx';

import {buildReportGroup, buildTransactionRow} from '../../utils/collections/searchListItems';
import createMock from '../../utils/createMock';

jest.mock('@libs/actions/Search', () => ({
    search: jest.fn(),
}));

const PAGE: number = CONST.SEARCH.RESULTS_PAGE_SIZE;
const mockedSearch = jest.mocked(search);

function getQueryJSON() {
    const queryJSON = buildSearchQueryJSON('type:expense-report action:submit');
    if (!queryJSON) {
        throw new Error('Query JSON should be defined for test setup');
    }
    return queryJSON;
}

function reportsOf(count: number, prefix = 'report') {
    return Array.from({length: count}, (_value, index) => buildReportGroup(index, `${prefix}${index}`, [buildTransactionRow(index, `${prefix}${index}-expense`)]));
}

const REPORT_POOL = reportsOf(PAGE * 5);

function deviceRowsOf(count: number) {
    return REPORT_POOL.slice(0, count);
}

function selectionOf(...keys: string[]): SelectedTransactions {
    return Object.fromEntries(keys.map((key) => [key, createMock<SelectedTransactionInfo>({isSelected: true})]));
}

type ReportRow = ReturnType<typeof reportsOf>[number];

function markDeleted(row: ReportRow): ReportRow {
    return {...row, pendingAction: CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE};
}

type PagingProps = Parameters<typeof useLiveSearchPaging>[0];

const defaultDeviceRows = deviceRowsOf(PAGE * 3);

const baseProps: PagingProps = {
    queryJSON: getQueryJSON(),
    searchKey: CONST.SEARCH.SEARCH_KEYS.SUBMIT,
    isLiveSearch: true,
    hasMoreServerResults: true,
    isOffline: false,
    isFocused: true,
    shouldCalculateTotalsOnFirstPage: false,
    shouldCalculateTotalsOnLaterPages: false,
    areRowsDeferred: false,
    deviceRows: defaultDeviceRows,
    deviceFilteredData: defaultDeviceRows,
    selectedTransactions: {},
};

/** A rerender applies its changes on top of the first render's props, not the previous render's. */
function renderPaging(overrides: Partial<PagingProps> = {}) {
    const initialProps = {...baseProps, ...overrides};
    const rendered = renderHook((props: PagingProps) => useLiveSearchPaging(props), {initialProps});
    return {
        result: rendered.result,
        rerender: (changes: Partial<PagingProps> = {}) => rendered.rerender({...initialProps, ...changes}),
    };
}

function withDeviceRows(count: number): Partial<PagingProps> {
    const rows = deviceRowsOf(count);
    return {deviceRows: rows, deviceFilteredData: rows};
}

async function flushPromises() {
    await act(async () => {
        await Promise.resolve();
    });
}

function requestedOffsets() {
    return mockedSearch.mock.calls.map(([params]) => params?.offset);
}

const SNAPSHOT_KEY = `${ONYXKEYS.COLLECTION.SNAPSHOT}${getQueryJSON().hash}` as const;

/** The snapshot every caller of `search()` shares, as this query's earlier requests would have left it. */
async function givenSharedPage({offset, isInFlight = false, didFail = false, hash = getQueryJSON().hash}: {offset: number; isInFlight?: boolean; didFail?: boolean; hash?: number}) {
    await act(async () => {
        await Onyx.set(
            SNAPSHOT_KEY,
            createMock<SearchResults>({
                search: {
                    hash,
                    offset,
                    state: isInFlight ? CONST.SEARCH.SNAPSHOT_STATE.LOADING : CONST.SEARCH.SNAPSHOT_STATE.LOADED,
                    ...(didFail ? {responseJsonCode: 500} : {}),
                },
            }),
        );
    });
}

function holdAnswer() {
    let deliver: (jsonCode: number) => void = () => {};
    const promise = new Promise<number>((resolve) => {
        deliver = resolve;
    });
    return {promise, answer: (jsonCode: number) => deliver(jsonCode)};
}

describe('useLiveSearchPaging', () => {
    beforeEach(() => {
        mockedSearch.mockReset();
        mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));
    });

    describe('the rows the user asks to see', () => {
        it('asks for the first page on mount and shows one page while it is on its way', async () => {
            // Given a to-do search whose rows are already in Onyx
            // When the hook mounts
            const {result} = renderPaging();

            // Then it asks for the first page itself, because the page-level fetch skips to-do searches, and it renders one page at once so the user isn't kept behind a skeleton
            expect(mockedSearch).toHaveBeenCalledWith(expect.objectContaining({offset: 0}));
            expect(result.current.visibleRows).toHaveLength(PAGE);

            await flushPromises();
        });

        it('shows the next page once the server answers it, with the loading indicator meanwhile', async () => {
            // Given a to-do search whose first page has answered, with the next page held back
            const {result} = renderPaging();
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            // When the user reaches the end of the list
            act(() => result.current.loadMoreRows());

            // Then the rows wait for that page, and the footer says so, which is how every other search behaves
            expect(result.current.visibleRows).toHaveLength(PAGE);
            expect(result.current.isLoadingMore).toBe(true);
            expect(requestedOffsets()).toEqual([0, PAGE]);

            // When the page answers
            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            // Then its rows appear and the footer goes away
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
            expect(result.current.isLoadingMore).toBe(false);
        });

        it('counts an end of the list once per change to its rows, and asks the server for one page at a time', async () => {
            // Given a to-do search with four pages of rows on the device and its next page held back
            const {result} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            // When the list reports its end twice on the same rows, which FlashList does on every new rows array
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());

            // Then only one page is asked for, or a list the device can't fill would walk the server's pages on its own
            expect(requestedOffsets()).toEqual([0, PAGE]);

            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);

            // When the user reaches the end again, now that the rows have changed
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then the next page goes out, because this end is the user asking for more rather than a repeat
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
        });

        it('stops asking when the pages it gets leave a list the device cannot fill unchanged', async () => {
            // Given a device holding fewer rows than one page, so answers never lengthen the list
            const {result} = renderPaging(withDeviceRows(20));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // When the list keeps reporting its end, which it does for each new rows array an answer brings
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then nothing more is asked for, so a short list can't walk the server's pages while the user sits still
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('keeps an end of the list reached while the first page is on its way', async () => {
            // Given a to-do search whose first page is still on its way
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result} = renderPaging();

            // When the user reaches the end before it answers
            act(() => result.current.loadMoreRows());

            expect(result.current.visibleRows).toHaveLength(PAGE);

            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            // Then that end isn't lost: the next page goes out once the first one lands, so the user doesn't have to scroll again
            expect(requestedOffsets()).toEqual([0, PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
        });

        it('asks for the next page after the first, for an end reached while it was on its way with no rows to spare', async () => {
            // Given a device holding exactly one page, so the answer adds no rows to show for that end
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result} = renderPaging(withDeviceRows(PAGE));

            // When the user reaches the end while the first page is on its way
            act(() => result.current.loadMoreRows());
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            // Then the next page is still asked for, since the rows the user wanted can only come from the server
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('keeps an end of the list reached on a short list while the first page is on its way', async () => {
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            // Given a device holding only three rows, so the list is shorter than a page
            const {result} = renderPaging(withDeviceRows(3));

            // When the user reaches the end while the first page is on its way
            act(() => result.current.loadMoreRows());
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            // Then the next page still goes out once it lands, because a short list gives the user no way to ask again
            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE]));
            await flushPromises();
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('asks for the next page at the end the answer brings, when the device has fewer rows than that page', async () => {
            // Given a device holding ten rows past the first page, so the second page only half fills
            const {result} = renderPaging(withDeviceRows(PAGE + 10));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            // When that page answers and the shorter list reaches its end again
            act(() => result.current.loadMoreRows());
            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            expect(result.current.visibleRows).toHaveLength(PAGE + 10);
            act(() => result.current.loadMoreRows());

            // Then the page after it goes out, because the rows the device lacks are the server's to fill
            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]));
            await flushPromises();
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);
        });

        it('ignores ends the list reports again on the same rows, however many rows the device holds', async () => {
            // Given five pages of rows on the device, so the list is long and has plenty left to show
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            // When the list reports its end three times without its rows changing
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();
            await flushPromises();

            // Then it costs one page, not three, so a burst of end events can't run the user through the server's pages
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('asks for more once the server has answered every row asked for, even when the device holds fewer', async () => {
            // Given a device holding three rows, all of them covered by the page that answered
            const {result} = renderPaging(withDeviceRows(3));
            await flushPromises();

            // When the user reaches the end of that short list
            act(() => result.current.loadMoreRows());

            // Then the next page goes out, since the server is the only place more rows can come from
            expect(requestedOffsets()).toEqual([0, PAGE]);

            await flushPromises();
        });

        it('ignores an end of the list reached while Search holds its rows back', async () => {
            // Given Search holding its rows back while the screen settles, which empties the list for a moment
            const {result, rerender} = renderPaging();
            await flushPromises();

            // When the empty list reports an end
            rerender({areRowsDeferred: true, deviceRows: [], deviceFilteredData: []});
            act(() => result.current.loadMoreRows());
            rerender();
            await flushPromises();

            // Then nothing is asked for, because the user never reached the bottom of anything
            expect(requestedOffsets()).toEqual([0]);
            expect(result.current.visibleRows).toHaveLength(PAGE);
        });

        it('counts an end on the same rows once the server has more to give again', async () => {
            // Given a server that reported no more pages, so an end of the list asks for nothing
            const {result, rerender} = renderPaging({...withDeviceRows(PAGE), hasMoreServerResults: false});
            await flushPromises();

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0]);

            // When reports arrive at the server and the user reaches the end again on the same rows
            rerender({...withDeviceRows(PAGE), hasMoreServerResults: true});
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then that end counts, because the earlier one was never spent on a request
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('stops asking once the device and the server are both exhausted', async () => {
            // Given a server with no more pages and a device holding one page
            const {result, rerender} = renderPaging({...withDeviceRows(PAGE), hasMoreServerResults: false});
            await flushPromises();

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0]);

            // When more reports reach the device from somewhere else, such as a reconnect
            rerender({...withDeviceRows(PAGE * 2), hasMoreServerResults: false});

            // Then they all show without a request, since paging has nothing left to follow
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
            expect(requestedOffsets()).toEqual([0]);
        });

        it('shows every row the device holds without asking, once the server reports no more pages', async () => {
            // Given a snapshot that already says the server has no more pages
            const {result} = renderPaging({hasMoreServerResults: false});

            // Then the list still starts at one page, because that flag is shared and may be left over from another caller
            expect(result.current.visibleRows).toHaveLength(PAGE);

            // When the first page answers and confirms it
            await flushPromises();

            // Then every row on the device shows at once, so "Select all" covers them and nothing is left unreachable
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
            expect(result.current.visibleFilteredData).toHaveLength(PAGE * 3);

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0]);
            expect(result.current.isLoadingMore).toBe(false);
        });
    });

    describe('the rows on screen', () => {
        it('hands selection only the rendered rows, in the order they render', async () => {
            // Given more reports on the device than one page, where selection receives them unsorted
            const reports = deviceRowsOf(PAGE + 5);

            // When the first page answers
            const {result} = renderPaging({deviceRows: reports, deviceFilteredData: [...reports].reverse()});
            await flushPromises();

            // Then selection gets exactly the rendered rows, in render order, so a bulk action can't reach a row the user cannot see
            const renderedKeys = reports.slice(0, PAGE).map((report) => report.keyForList);
            expect(result.current.visibleRows.map((row) => row.keyForList)).toEqual(renderedKeys);
            expect(result.current.visibleFilteredData.map((row) => row.keyForList)).toEqual(renderedKeys);
        });

        it('passes both lists through untouched while every row fits', async () => {
            // Given a device holding exactly one page, so nothing is cut off
            const rows = deviceRowsOf(PAGE);
            const sections = [...rows].reverse();

            // When the hook runs
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: sections});
            await flushPromises();

            // Then both lists come back as they were, which keeps the list from re-rendering over a copy of itself
            expect(result.current.visibleRows).toBe(rows);
            expect(result.current.visibleFilteredData).toBe(sections);
        });

        it('keeps the rendered rows across a render that changes nothing they depend on', async () => {
            // Given a rendered to-do list
            const {result, rerender} = renderPaging();
            await flushPromises();
            const firstRows = result.current.visibleRows;
            const firstSelectionRows = result.current.visibleFilteredData;

            // When something unrelated to the rows changes, here the totals flag
            rerender({shouldCalculateTotalsOnFirstPage: true});

            // Then the same arrays come back, so the list doesn't re-render every row over a change it doesn't care about
            expect(result.current.visibleRows).toBe(firstRows);
            expect(result.current.visibleFilteredData).toBe(firstSelectionRows);
        });

        it('shows the rows an end reached offline wanted only once their page answers', async () => {
            // Given a to-do list offline
            const {result, rerender} = renderPaging({isOffline: true});

            // When the user reaches the end
            act(() => result.current.loadMoreRows());

            // Then the rows stay at one page, because a row is shown only when a page backs it
            expect(result.current.visibleRows).toHaveLength(PAGE);

            // When the connection is back and the page it owed answers
            rerender({isOffline: false});

            // Then those rows appear
            await waitFor(() => expect(result.current.visibleRows).toHaveLength(PAGE * 2));
        });

        it('gives the place of a report being deleted online to the next report the device holds', async () => {
            // Given a whole page of reports being deleted, which the list hides while online
            const reports = deviceRowsOf(PAGE * 3);
            const rows = [...reports.slice(0, PAGE).map(markDeleted), ...reports.slice(PAGE)];

            // When the first page answers
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: rows});
            await flushPromises();

            // Then the reports after them fill the page, so a delete doesn't leave the user with an empty-looking list
            expect(result.current.visibleRows).toEqual(rows.slice(0, PAGE * 2));
            expect(result.current.visibleFilteredData).toEqual(rows.slice(0, PAGE * 2));
        });

        it('passes both lists through untouched while every shown report fits, however many are being deleted', async () => {
            // Given ten reports being deleted, with everything that remains still fitting in a page
            const reports = deviceRowsOf(PAGE + 10);
            const rows = [...reports.slice(0, 10).map(markDeleted), ...reports.slice(10)];
            const sections = [...rows].reverse();

            // When the hook runs
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: sections});
            await flushPromises();

            // Then both lists pass through as they were, so a delete alone doesn't rebuild the rows
            expect(result.current.visibleRows).toBe(rows);
            expect(result.current.visibleFilteredData).toBe(sections);
        });

        it('counts a report being deleted offline, where it shows struck through', async () => {
            // Given a page of reports being deleted, while offline
            const reports = deviceRowsOf(PAGE * 3);
            const rows = [...reports.slice(0, PAGE).map(markDeleted), ...reports.slice(PAGE)];

            // When the hook runs
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: rows, isOffline: true});

            // Then they take up their places, because offline the user still sees them struck through until the delete goes out
            expect(result.current.visibleRows).toEqual(rows.slice(0, PAGE));
        });

        it('renders every row the device holds for a snapshot-backed search', async () => {
            // Given a search whose rows come from the snapshot rather than Onyx
            // When the hook runs
            const {result} = renderPaging({isLiveSearch: false});

            // Then both lists pass straight through, because paging there belongs to Search, not to this hook
            expect(result.current.visibleRows).toBe(baseProps.deviceRows);
            expect(result.current.visibleFilteredData).toBe(baseProps.deviceFilteredData);

            await flushPromises();
        });
    });

    describe('a selected row', () => {
        it('stays on screen when reports arriving above push it past the limit', async () => {
            // Given the last rendered report ticked, which the user does through one of its expenses
            const reports = deviceRowsOf(PAGE + 5);
            const lastShown = reports.at(PAGE - 1)?.keyForList ?? '';
            const {result, rerender} = renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf(`${lastShown}-expense`)});
            await flushPromises();

            // When three reports arrive above it and push it past the limit
            const withNewReports = [...reportsOf(3, 'new'), ...reports];
            rerender({deviceRows: withNewReports, deviceFilteredData: withNewReports});

            // Then the list renders down to it, because selection drops any ticked row that stops being rendered
            expect(result.current.visibleRows).toHaveLength(PAGE + 3);
            expect(result.current.visibleRows.at(-1)?.keyForList).toBe(lastShown);
            expect(result.current.visibleFilteredData.at(-1)?.keyForList).toBe(lastShown);
        });

        it('stays on screen once its tick is cleared', async () => {
            // Given a ticked report two rows past the limit, which the list renders down to
            const reports = deviceRowsOf(PAGE + 5);
            const {result, rerender} = renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf(`report${PAGE + 1}-expense`)});
            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE + 2);

            // When the user clears its tick
            rerender({selectedTransactions: {}});

            // Then the rows stay, because pulling rows away under the user would be worse than showing a few extra
            expect(result.current.visibleRows).toHaveLength(PAGE + 2);
        });

        it('keeps an empty report on screen, which holds its tick under its own key', async () => {
            // Given a ticked report with no expenses, which is ticked under its own key rather than an expense's
            const reports = [...deviceRowsOf(PAGE), buildReportGroup(PAGE, 'empty')];

            // When the list renders
            const {result} = renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf('empty')});
            await flushPromises();

            // Then it is kept on screen too, so an empty draft doesn't lose its tick
            expect(result.current.visibleRows.at(-1)?.keyForList).toBe('empty');
        });

        it('is not kept on screen by a tick that is not selected', async () => {
            // Given a selection entry past the limit whose tick the user has already cleared
            const reports = deviceRowsOf(PAGE + 5);
            const clearedTick = {[`report${PAGE + 1}-expense`]: createMock<SelectedTransactionInfo>({isSelected: false})};

            // When the list renders
            const {result} = renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: clearedTick});
            await flushPromises();

            // Then the list stops at one page, because a cleared entry isn't a row anyone is holding on screen
            expect(result.current.visibleRows).toHaveLength(PAGE);
        });

        it('does not make the server owe more pages', async () => {
            // Given a ticked report past the limit, which the list renders down to
            const reports = deviceRowsOf(PAGE + 5);

            // When the list settles
            renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf(`report${PAGE + 1}-expense`)});
            await flushPromises();
            await flushPromises();

            // Then no extra page is asked for, because those rows are already on the device and the user asked for nothing
            expect(requestedOffsets()).toEqual([0]);
        });

        it('ends the list at it when reports being deleted sit above it', async () => {
            // Given ten reports being deleted above a ticked report, which the list hides while online
            const reports = deviceRowsOf(PAGE * 3);
            const rows = [...reports.slice(0, 10).map(markDeleted), ...reports.slice(10)];
            const selectedKey = rows.at(PAGE + 20)?.keyForList ?? '';

            // When the list renders
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: rows, selectedTransactions: selectionOf(selectedKey)});
            await flushPromises();

            // Then it ends at the ticked report, counting only shown rows, so hidden ones don't push the limit further down
            expect(result.current.visibleRows.at(-1)?.keyForList).toBe(selectedKey);
        });

        it('lets the list grow past it at the next end of the list', async () => {
            // Given a ticked report far past the limit, which holds the list open down to it
            const {result} = renderPaging({selectedTransactions: selectionOf(`report${PAGE + 20}-expense`)});
            await flushPromises();

            // When the user reaches the end
            act(() => result.current.loadMoreRows());

            // Then the list grows a page past it, rather than treating the widened list as already satisfied
            expect(result.current.visibleRows).toHaveLength(PAGE * 2 + 21);
            await flushPromises();
        });

        it('does not take rows held back while Search settles for rows the device lacks', async () => {
            // Given a list widened by a ticked report, which has asked the server for its next page
            const {result, rerender} = renderPaging({selectedTransactions: selectionOf(`report${PAGE + 20}-expense`)});
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // When Search holds its rows back and the list empties for a moment
            rerender({areRowsDeferred: true, deviceRows: [], deviceFilteredData: []});
            await flushPromises();

            // Then no catch-up pages go out, because rows that are only hidden aren't rows the device is missing
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('asks the server for one page per end once the list has run past it', async () => {
            // Given a ticked report a page past the limit, so the list already renders further than the server has answered
            const {result} = renderPaging({...withDeviceRows(PAGE * 5), selectedTransactions: selectionOf(`report${PAGE * 2}-expense`)});
            await flushPromises();

            // When the user reaches the end twice, with the rows changing in between
            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE * 3 + 1);
            expect(requestedOffsets()).toEqual([0, PAGE]);

            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then each end costs one page, so a list widened by a ticked row doesn't run through the server's pages at once
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);
        });

        it('asks the server for the rows the device lacks once the list has run past it', async () => {
            // Given a list widened past everything the device holds by a ticked report
            const secondPage = holdAnswer();
            const {result, rerender} = renderPaging({...withDeviceRows(PAGE + 21), selectedTransactions: selectionOf(`report${PAGE + 20}-expense`)});
            await flushPromises();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            // When the user reaches the end and the page answers
            act(() => result.current.loadMoreRows());

            expect(result.current.isLoadingMore).toBe(true);

            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            // Then the owed pages go out one after another, each from the cursor, because skipping an offset can skip reports
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);

            // When those pages bring the missing rows and the user reaches the end again
            rerender(withDeviceRows(PAGE * 4));
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then paging carries on from there
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2, PAGE * 3]);
        });

        it('does not change the rows of a snapshot-backed search', async () => {
            // Given a ticked row past the limit on a search whose rows come from the snapshot
            const reports = deviceRowsOf(PAGE + 5);

            // When the hook runs
            const {result} = renderPaging({isLiveSearch: false, deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf(`report${PAGE + 1}-expense`)});
            await flushPromises();

            // Then it leaves the rows alone and sends nothing, because Search still owns paging there
            expect(result.current.visibleRows).toBe(reports);
            expect(mockedSearch).not.toHaveBeenCalled();
        });
    });

    describe('a highlighted row', () => {
        function withHighlightOn(reports: ReturnType<typeof reportsOf>, key: string) {
            return reports.map((report) => (report.keyForList === key ? {...report, shouldAnimateInHighlight: true} : report));
        }

        it('stays on screen when a new expense lands in a report past the limit', async () => {
            // Given a new expense in a report five rows past the limit, which the app wants to scroll to and highlight
            const reports = withHighlightOn(deviceRowsOf(PAGE + 10), `report${PAGE + 5}`);

            // When the list renders
            const {result} = renderPaging({deviceRows: reports, deviceFilteredData: reports});
            await flushPromises();

            // Then the list reaches that report without asking for a page, because the scroll can only reach a rendered row
            expect(result.current.visibleRows.findIndex((row) => row.keyForList === `report${PAGE + 5}`)).toBe(PAGE + 5);
            expect(result.current.visibleRows).toHaveLength(PAGE + 6);
            expect(requestedOffsets()).toEqual([0]);
        });

        it('stays on screen once the highlight ends', async () => {
            // Given a highlighted report past the limit, which the list renders down to
            const reports = deviceRowsOf(PAGE + 10);
            const highlighted = withHighlightOn(reports, `report${PAGE + 5}`);
            const {result, rerender} = renderPaging({deviceRows: highlighted, deviceFilteredData: highlighted});
            await flushPromises();

            // When the highlight ends
            rerender({deviceRows: reports, deviceFilteredData: reports});

            // Then the rows stay, so the list doesn't shrink under the user once the animation is over
            expect(result.current.visibleRows).toHaveLength(PAGE + 6);
        });
    });

    describe('the pages the server owes', () => {
        it('asks with the query, key and first-page totals flag it was given', async () => {
            // Given a to-do search whose first page needs totals
            // When the hook sends it
            renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            // Then the request carries what Search handed the hook, and `isLoading: false`, which the shared flag would otherwise block
            expect(mockedSearch).toHaveBeenCalledWith({queryJSON: baseProps.queryJSON, searchKey: CONST.SEARCH.SEARCH_KEYS.SUBMIT, offset: 0, shouldCalculateTotals: true, isLoading: false});
        });

        it('asks for totals past the first page only when every page needs them', async () => {
            // Given a search where only the first page needs totals
            const {result} = renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            // When the user pages on
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then the later page goes without them, since recalculating totals on every page costs the server work nobody reads
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: false}));
        });

        it('sends each page with the totals flag current when it goes out', async () => {
            // Given the first page on its way before every matching report is selected
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result, rerender} = renderPaging();

            // When the selection turns on while it is in flight, and the user then pages
            rerender({shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            act(() => result.current.loadMoreRows());

            // Then the new page carries totals, because each request reads the flag as it goes out rather than as it was queued
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));

            await flushPromises();
        });

        it('asks again for the last page it has once the connection is back, since what it said may have changed', async () => {
            // Given a search that has answered two pages
            const {result, rerender} = renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // When the connection drops and comes back
            rerender({isOffline: true});
            rerender();
            await flushPromises();

            // Then the last page is asked for again, because reports can be acted on elsewhere while the device is away
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: false}));

            // When the user reaches the end afterwards
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then paging carries on from where it was, rather than starting again
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE * 2]);
        });

        it('asks again for the first page, with its totals, once the connection is back before any other page', async () => {
            // Given a search that has only answered its first page
            const {rerender} = renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            // When the connection drops and comes back
            rerender({isOffline: true});
            rerender();
            await flushPromises();

            // Then that page is refreshed with its totals, so the footer and the selection count are current again
            expect(requestedOffsets()).toEqual([0, 0]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: 0, shouldCalculateTotals: true}));
        });

        it('asks again for the last page it has, with totals, once every matching report is selected', async () => {
            // Given a search that has answered two pages without totals
            const {result, rerender} = renderPaging();
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // When the user selects every matching report, which the bulk-action button counts from the server
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await flushPromises();
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await flushPromises();

            // Then the last page is asked for again with totals, so "N selected" shows a count and not a spinner
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));
        });

        it('still asks for the last page when one sent before every matching report was selected answers first', async () => {
            // Given a page already on its way when the user selects every matching report
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();
            const thirdPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(thirdPage.promise);
            act(() => result.current.loadMoreRows());

            // When that page answers
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                thirdPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            // Then the refresh still goes out, because a page sent before the selection cannot carry the totals it needs
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2, PAGE * 2]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE * 2, shouldCalculateTotals: true}));
        });

        it('still asks for the last page with totals when every matching report is selected while a reconnect refresh is on its way', async () => {
            // Given a reconnect refresh already on its way, sent without totals
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();
            const refresh = holdAnswer();
            mockedSearch.mockReturnValueOnce(refresh.promise);

            rerender({isOffline: true});
            rerender();
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: false}));

            // When the user selects every matching report before it answers
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                refresh.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            // Then a second refresh goes out with totals, since the one in flight was never going to bring the count
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));
        });

        it('asks again for the first page, with its totals, once every matching report is selected, since live changes may have made its count stale', async () => {
            // Given only the first page answered, whose totals were counted when it landed
            const {rerender} = renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            // When the user selects every matching report
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await flushPromises();
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await flushPromises();

            // Then it is asked for again, because rows move under a to-do tab and its saved count may no longer match
            expect(requestedOffsets()).toEqual([0, 0]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: 0, shouldCalculateTotals: true}));
        });

        it('does not ask for the first page twice when every matching report is selected while it is on its way', async () => {
            // Given the first page still on its way, already carrying totals
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {rerender} = renderPaging({shouldCalculateTotalsOnFirstPage: true});

            // When the user selects every matching report before it answers
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            // Then nothing extra goes out, because that answer already brings the count the selection needs
            expect(requestedOffsets()).toEqual([0]);
        });

        it('asks for the last page with totals once the page on its way answers, when every matching report is selected while it loads', async () => {
            // Given a second page on its way, sent without totals
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            // When the user selects every matching report while it loads
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            // Then the refresh waits for that page and then goes out, so two requests never run at once
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));
        });

        it('asks for a totals refresh that failed again once paging is unblocked, and not before', async () => {
            // Given a totals refresh that the server failed, which blocks paging
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();
            mockedSearch.mockReturnValueOnce(Promise.resolve(500));

            const allMatching = {shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true};
            rerender(allMatching);
            await flushPromises();
            rerender(allMatching);
            await flushPromises();

            // Then it isn't repeated on every render, or a failing server would be asked in a loop
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            // When the user leaves the screen and comes back, which lifts the block
            rerender({...allMatching, isFocused: false});
            rerender(allMatching);
            await flushPromises();

            // Then it is asked for again, so the count the selection needs isn't lost to one failure
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));
        });

        it('sends the page again when the one it left behind fails after the user came back to the screen', async () => {
            // Given a page still out when the user left the screen and came back, which is what a stuck request looks like
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            rerender({isFocused: false});
            rerender();

            // When that page finally fails
            await act(async () => {
                secondPage.answer(500);
            });
            await flushPromises();

            // Then the page goes out again rather than the list waiting on a request nobody is holding any more
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);
        });

        it('sends the page again when the one it replaced fails on a connection that is already gone', async () => {
            // Given a page still out when the connection dropped and came back, which owes a refresh
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            rerender({isOffline: true});
            rerender();

            // When that page fails, which it does on a connection nothing is waiting on any more
            await act(async () => {
                secondPage.answer(500);
            });
            await flushPromises();

            // Then it goes out again at once, because a failure from an older connection says nothing about this one
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            // When the user leaves the screen and comes back, which is what lifts a real block
            rerender({isFocused: false});
            rerender();
            await flushPromises();
            rerender();
            await flushPromises();

            // Then nothing else is sent, because that retry also settled the refresh the reconnect owed
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);
        });

        it('asks for a refresh a reconnect owes again once paging is unblocked, when it failed', async () => {
            // Given a reconnect refresh that the server failed
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();
            mockedSearch.mockReturnValueOnce(Promise.resolve(500));

            rerender({isOffline: true});
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            // When the user leaves the screen and comes back, which lifts the block
            rerender({isFocused: false});
            rerender();
            await flushPromises();
            rerender();
            await flushPromises();

            // Then the refresh is asked for again, because a failure leaves the rows as stale as before it
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE]);
        });

        it('sends nothing once its search stops being a to-do search', async () => {
            // Given a to-do search that has already paged
            const {result, rerender} = renderPaging();
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();
            mockedSearch.mockClear();

            // When the query stops being a to-do search while its screen stays mounted
            rerender({isLiveSearch: false, isOffline: true});
            rerender({isLiveSearch: false});
            await flushPromises();

            // Then nothing more goes out, since Search's own paging takes over from here
            expect(mockedSearch).not.toHaveBeenCalled();
        });

        it('waits for the screen to be focused before asking for anything', async () => {
            // Given a to-do search whose screen isn't focused, such as a tab behind the one being read
            const {result, rerender} = renderPaging({isFocused: false});
            await flushPromises();

            // When the list reports an end there
            act(() => result.current.loadMoreRows());

            // Then nothing is asked for, so a background tab doesn't spend requests, though its rows still render
            expect(mockedSearch).not.toHaveBeenCalled();
            expect(result.current.visibleRows).toHaveLength(PAGE);

            // When the screen is focused
            rerender({isFocused: true});
            await flushPromises();

            // Then the first page goes out
            expect(requestedOffsets()).toEqual([0]);
        });

        it('keeps a page answered while an unrelated prop changed, rather than asking for it twice', async () => {
            // Given the first page on its way when an unrelated prop changes, here the totals flag
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));

            // When it answers
            rerender({shouldCalculateTotalsOnFirstPage: true});
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            // Then it counts as answered, rather than being sent again because the props moved under it
            expect(requestedOffsets()).toEqual([0]);

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0, PAGE]);

            await flushPromises();
        });

        it('asks for the pages it owes once the connection is back, then one page per end', async () => {
            // Given a list that reached its end twice while offline, where ends on the same rows count once
            const {result, rerender} = renderPaging({isOffline: true, ...withDeviceRows(PAGE * 4)});
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());

            expect(result.current.visibleRows).toHaveLength(PAGE);
            expect(mockedSearch).not.toHaveBeenCalled();

            // When the connection comes back
            rerender({isOffline: false});
            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE]));
            await flushPromises();

            // Then the pages it owes go out and their rows show, without paying for the repeated end
            expect(requestedOffsets()).toEqual([0, PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);

            // When the user reaches the end again
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then paging carries on one page at a time
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
        });

        it('stops asking for the pages it owes once the server reports it has no more', async () => {
            // Given ends reached offline that owe pages, with the first page still on its way
            const {result, rerender} = renderPaging({isOffline: true});
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            rerender({isOffline: false});

            // When that page answers and says the server has nothing more
            rerender({isOffline: false, hasMoreServerResults: false});
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            // Then the owed pages are dropped and every row shows, since asking for pages past the end buys nothing
            expect(requestedOffsets()).toEqual([0]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
        });

        it('keeps paging after a cover and reveal cycle, which cleans up its effects and runs them again', async () => {
            // Given a screen covered and revealed again, which StrictMode reproduces by cleaning up effects and running them anew while refs survive
            const {result} = renderHook((props: PagingProps) => useLiveSearchPaging(props), {initialProps: {...baseProps, ...withDeviceRows(PAGE * 4)}, wrapper: StrictMode});
            await flushPromises();

            // When the user pages twice
            act(() => result.current.loadMoreRows());
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then each end costs one page, so the cycle neither duplicates requests nor strands the list
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);
        });

        it('counts a page that answers while the list is hidden', async () => {
            // Given a page on its way when the screen is hidden, which destroys effects but keeps state
            let activityMode: 'visible' | 'hidden' = 'visible';
            function ActivityWrapper({children}: {children: ReactNode}) {
                return <Activity mode={activityMode}>{children}</Activity>;
            }
            const {result, rerender} = renderHook((props: PagingProps) => useLiveSearchPaging(props), {initialProps: {...baseProps, ...withDeviceRows(PAGE * 4)}, wrapper: ActivityWrapper});
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            // When it answers while hidden and the screen comes back
            activityMode = 'hidden';
            rerender({...baseProps, ...withDeviceRows(PAGE * 4)});
            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            activityMode = 'visible';
            rerender({...baseProps, ...withDeviceRows(PAGE * 4)});
            await flushPromises();

            // Then the answer still counts, so the user doesn't return to a list that asks for the same page again
            expect(requestedOffsets()).toEqual([0, PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
        });

        it('reports the last page the server answered, which report navigation pages on from', async () => {
            // Given a to-do search that has answered its first page
            const {result} = renderPaging();
            await flushPromises();

            expect(result.current.lastPageOffset).toBe(0);

            // When it pages on
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then it reports that page, so opening a report saves where paging really is instead of the snapshot's shared offset
            expect(result.current.lastPageOffset).toBe(PAGE);
        });

        it('does nothing at all for a snapshot-backed search', async () => {
            // Given a search whose rows come from the snapshot
            const {result} = renderPaging({isLiveSearch: false});

            // When the list reports an end
            act(() => result.current.loadMoreRows());

            // Then nothing is sent, because Search's own paging would otherwise send the same page twice
            expect(mockedSearch).not.toHaveBeenCalled();

            await flushPromises();
        });

        it('adds no render of its own to a snapshot-backed search when focus, the connection or the selection changes', () => {
            // Given a snapshot-backed search, where every render costs the whole of Search
            const onRender = jest.fn();
            const initialProps: PagingProps = {...baseProps, isLiveSearch: false};
            const {rerender} = renderHook(
                (props: PagingProps) => {
                    onRender();
                    return useLiveSearchPaging(props);
                },
                {initialProps},
            );
            onRender.mockClear();

            // When focus, the connection and the selection change
            rerender({...initialProps, isOffline: true});
            rerender({...initialProps, isFocused: false});
            rerender({...initialProps, shouldCalculateTotalsOnLaterPages: true});

            // Then the hook adds no render of its own, since it tracks those changes only where they drive paging
            expect(onRender).toHaveBeenCalledTimes(3);
        });
    });

    describe('while offline', () => {
        it('keeps the list at one page, and asks for the pages it owes once the connection is back', async () => {
            // Given a to-do search opened offline
            const {result, rerender} = renderPaging({isOffline: true});

            // When the user reaches the end of the list
            act(() => result.current.loadMoreRows());

            // Then nothing is sent and the rows hold, because a row shows only when a page backs it
            expect(mockedSearch).not.toHaveBeenCalled();
            expect(result.current.visibleRows).toHaveLength(PAGE);

            // When the connection comes back
            rerender({isOffline: false});

            // Then the pages it owes go out and their rows appear, so the end reached offline isn't forgotten
            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE]));
            await flushPromises();
            expect(requestedOffsets()).toEqual([0, PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
        });

        it('keeps the list at the answered pages while a page that started online is still pending', async () => {
            // Given a page sent online that never settles, which is what a request stuck behind the write queue looks like offline
            mockedSearch.mockReturnValue(holdAnswer().promise);
            const {result, rerender} = renderPaging();

            // When the connection drops and the user reaches the end
            rerender({isOffline: true});
            act(() => result.current.loadMoreRows());

            // Then the rows hold at the page that answered, rather than filling in from the device behind a pending request
            expect(result.current.visibleRows).toHaveLength(PAGE);
            expect(requestedOffsets()).toEqual([0]);
        });

        it('asks for the page an end of the list wanted once the connection is back, when the device had no rows to spare', async () => {
            // Given a device holding exactly one page, so an end reached offline can only be answered by the server
            const {result, rerender} = renderPaging({...withDeviceRows(PAGE), isOffline: true});

            // When the user reaches that end and the connection comes back
            act(() => result.current.loadMoreRows());
            rerender({isOffline: false});

            // Then both the first page and the page that end wanted go out
            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE]));
        });

        it('keeps an end of the list reached offline on a short list, and asks for that page after the one it owes', async () => {
            // Given a device holding three rows, a list too short for the user to reach its end again
            const {result, rerender} = renderPaging({...withDeviceRows(3), isOffline: true});

            // When the user reaches that end and the connection comes back
            act(() => result.current.loadMoreRows());
            rerender({isOffline: false});

            // Then the page it wanted follows the first one, and no more, so a short list neither stalls nor runs away
            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE]));
            await flushPromises();
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });
    });

    describe('a page that goes unanswered', () => {
        it('is not asked for again until the list reaches its end, while the list stays at the page it has', async () => {
            // Given a page the server failed
            const {result, rerender} = renderPaging();
            await flushPromises();
            mockedSearch.mockReturnValue(Promise.resolve(500));

            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then the rows hold at the page that answered, because a failure is no reason to show rows nothing has confirmed
            expect(result.current.visibleRows).toHaveLength(PAGE);

            // When renders keep coming, here from an unrelated prop
            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));
            rerender({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            // Then nothing is sent, so a failing server isn't asked on every render
            expect(mockedSearch).not.toHaveBeenCalled();

            // When the user reaches the end again
            act(() => result.current.loadMoreRows());

            // Then the page is asked for once more, since the user asking is what makes a retry worth sending
            expect(requestedOffsets()).toEqual([PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE);

            await flushPromises();
        });

        it('is asked for again at the next end of the list, even when no rows could show', async () => {
            // Given a failed page on a device holding exactly one page, so the failure changed nothing on screen
            const {result} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();
            mockedSearch.mockReturnValue(Promise.resolve(500));

            act(() => result.current.loadMoreRows());
            await flushPromises();
            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            // When the user reaches the end again
            act(() => result.current.loadMoreRows());

            // Then the retry goes out even though the rows never changed, or a short list could never recover
            expect(requestedOffsets()).toEqual([PAGE]);

            await flushPromises();
            await flushPromises();

            expect(requestedOffsets()).toEqual([PAGE]);
        });

        it('is asked for again at each end of the list while it keeps failing, but only once for one end', async () => {
            // Given a page on its way from an end of the list, where the rows can't grow to mark a new end
            const {result} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();
            const heldPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(heldPage.promise);

            // When the list reports that end twice while the page is still on its way
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());

            // Then it costs one request, because the second is the same end reported again
            expect(requestedOffsets()).toEqual([0, PAGE]);

            // When the page fails and the user reaches the end twice more
            mockedSearch.mockReturnValue(Promise.resolve(500));
            await act(async () => {
                heldPage.answer(500);
            });
            act(() => result.current.loadMoreRows());
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then each of those ends retries the page, or a failing server would leave the list stuck with nothing the user could do
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE]);
        });

        it('is asked for again after a failed first page, whatever a stale snapshot claims', async () => {
            // Given a failed first page on a snapshot that claims the server has no more, a flag every caller of search() shares
            mockedSearch.mockReturnValue(Promise.resolve(500));
            const {result} = renderPaging({hasMoreServerResults: false});
            await flushPromises();
            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            // When the user reaches the end
            act(() => result.current.loadMoreRows());

            // Then the first page is asked for again, because that claim was never confirmed by a page of this search
            expect(requestedOffsets()).toEqual([0]);

            await flushPromises();
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
        });

        it('treats a page search() did not send as unanswered, and asks for it again at the next end', async () => {
            // Given a page search() never sends, which is what it does while a delete finishes or when the same page is already in flight
            const {result} = renderPaging();
            await flushPromises();
            mockedSearch.mockReturnValueOnce(undefined);

            // When the user reaches the end
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then the rows hold and no footer shows, because nothing is on its way
            expect(result.current.visibleRows).toHaveLength(PAGE);
            expect(result.current.isLoadingMore).toBe(false);

            // When the user reaches the end again
            act(() => result.current.loadMoreRows());

            // Then the page is asked for again, so a page nobody sent isn't mistaken for one that arrived
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            await flushPromises();
        });

        it('treats a search that throws while it is being built as unanswered, rather than letting the error escape', async () => {
            // Given a search that throws while its request is being built
            const {result} = renderPaging();
            await flushPromises();
            mockedSearch.mockImplementationOnce(() => {
                throw new Error('query could not be built');
            });

            // When the user reaches the end
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then the throw is contained and counted as a failed page, instead of escaping the Effect and breaking the screen
            expect(result.current.visibleRows).toHaveLength(PAGE);
            expect(result.current.isLoadingMore).toBe(false);

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            await flushPromises();
        });

        it('treats a request that fails outright as unanswered', async () => {
            // Given a request that rejects rather than answering, as one that never reaches the server does
            const {result} = renderPaging();
            await flushPromises();
            mockedSearch.mockReturnValueOnce(Promise.reject(new Error('request could not be sent')));

            // When the user reaches the end
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then it counts as a failed page and is asked for again at the next end, so paging doesn't stop on a rejection
            expect(result.current.visibleRows).toHaveLength(PAGE);
            expect(result.current.isLoadingMore).toBe(false);

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            await flushPromises();
        });

        it('is asked for again on reconnect when a dropped connection lost it, and once more on the next reconnect only as a refresh', async () => {
            // Given a first page lost to a dropped connection, which search() reports by resolving with nothing
            mockedSearch.mockReturnValue(Promise.resolve(undefined));
            const {rerender} = renderPaging();
            await flushPromises();
            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            // When the connection comes back
            rerender({isOffline: true});
            rerender();
            await flushPromises();

            // Then the lost page goes out again, since the user is otherwise left with a list that never fills
            expect(requestedOffsets()).toEqual([0]);

            // When the connection drops and returns a second time
            rerender({isOffline: true});
            rerender();
            await flushPromises();
            rerender();
            await flushPromises();

            // Then it is sent once more as a refresh, not twice, so a flapping connection costs one request per reconnect
            expect(requestedOffsets()).toEqual([0, 0]);
        });

        it('is asked for again when the screen is focused again', async () => {
            // Given a first page the server failed
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.EXP_ERROR));
            const {rerender} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            // When the user leaves the screen and comes back, as they do when a report is opened and closed
            rerender({isFocused: false});
            rerender();
            await flushPromises();

            // Then the page is asked for again, which is the one way a list too short to reach an end can recover
            expect(requestedOffsets()).toEqual([0, 0]);
        });

        it('is asked for again on the next reconnect after a server error, not on every render before it', async () => {
            // Given a first page the server failed with an error
            mockedSearch.mockReturnValue(Promise.resolve(500));
            const {rerender} = renderPaging();
            await flushPromises();
            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            // When renders keep coming before the connection changes
            rerender({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            expect(mockedSearch).not.toHaveBeenCalled();

            // When the connection drops and comes back
            rerender({shouldCalculateTotalsOnFirstPage: true, isOffline: true});
            rerender({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            // Then the page goes out once, so a server error costs one retry per reconnect rather than one per render
            expect(requestedOffsets()).toEqual([0]);
        });
    });

    describe('the loading indicator', () => {
        it('shows only once the list has reached an end', async () => {
            // Given a to-do search on mount, whose first rows render without waiting for anything
            const {result} = renderPaging(withDeviceRows(PAGE * 4));

            // Then no footer shows, because nothing is missing from the screen yet
            expect(result.current.isLoadingMore).toBe(false);
            await flushPromises();
            expect(result.current.isLoadingMore).toBe(false);

            // When the user reaches the end and a page goes out
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            // Then the footer shows, telling the user the rows they asked for are on their way
            expect(result.current.isLoadingMore).toBe(true);

            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            // Then it goes away once they arrive
            expect(result.current.isLoadingMore).toBe(false);
        });

        it('shows at an end reached while the first page is still on its way, but not under a short list on mount', async () => {
            // Given a device holding 30 rows, a list short enough to sit at its end from the start, with the first page still loading
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result} = renderPaging(withDeviceRows(30));

            // Then no footer shows on mount, or every short list would open under a skeleton
            expect(result.current.isLoadingMore).toBe(false);

            // When the user reaches the end
            act(() => result.current.loadMoreRows());

            // Then it shows, because from here the user is waiting for rows
            expect(result.current.isLoadingMore).toBe(true);

            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();
        });

        it('stays hidden while offline, where a page is only owed rather than on its way', async () => {
            // Given a to-do list offline
            const {result, rerender} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();

            // When the user reaches the end, which owes a page for the next reconnect
            rerender({isOffline: true});
            act(() => result.current.loadMoreRows());

            // Then no footer shows, since nothing can arrive until the connection is back
            expect(result.current.isLoadingMore).toBe(false);
        });

        it('stays hidden while Search holds its rows back', async () => {
            // Given a page on its way when Search holds its rows back and the list empties
            const secondPage = holdAnswer();
            const {result, rerender} = renderPaging();
            await flushPromises();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            // When the rows are deferred
            rerender({areRowsDeferred: true, deviceRows: [], deviceFilteredData: []});

            // Then no footer shows, or a skeleton would sit alone over an empty list
            expect(result.current.isLoadingMore).toBe(false);

            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
        });

        it('stays hidden once a page goes unanswered', async () => {
            // Given a page the server failed
            const {result} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();
            mockedSearch.mockReturnValue(Promise.resolve(500));

            // When the failure lands
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then the footer goes away, rather than spinning over rows that are no longer coming
            expect(result.current.isLoadingMore).toBe(false);
        });

        it('shows once the connection is back, while the page an end reached offline asked for is on its way', async () => {
            // Given ends reached offline, which owe a page
            const {result, rerender} = renderPaging();
            await flushPromises();
            rerender({isOffline: true});
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            mockedSearch.mockReturnValue(holdAnswer().promise);

            // When the connection comes back and that page goes out
            rerender({isOffline: false});

            // Then the rows still wait, and the footer shows while they do
            expect(result.current.visibleRows).toHaveLength(PAGE);
            expect(result.current.isLoadingMore).toBe(true);
        });
    });

    describe('the pages it inherits at mount', () => {
        afterEach(async () => {
            await act(async () => {
                await Onyx.set(SNAPSHOT_KEY, null);
            });
        });

        it('shows the pages the snapshot was already given, and asks for nothing', async () => {
            // Given a snapshot this query filled earlier, which survives a remount and a reload
            await givenSharedPage({offset: PAGE * 2});

            // When the hook mounts on it
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();

            // Then those rows are back without a request, because the server already sent them and the rows never left Onyx
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
            expect(mockedSearch).not.toHaveBeenCalled();
        });

        it('inherits nothing from a snapshot that belongs to another query', async () => {
            // Given a snapshot left by a different search, which a hash tells apart from this one's
            await givenSharedPage({offset: PAGE * 2, hash: 999});

            // When the hook mounts
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();

            // Then it starts from the beginning, since those pages say nothing about this query
            expect(result.current.visibleRows).toHaveLength(PAGE);
            expect(requestedOffsets()).toEqual([0]);
        });

        it('does not count a page the snapshot asked for but never received', async () => {
            // Given a snapshot whose last request failed, which still moved its cursor
            await givenSharedPage({offset: PAGE * 2, didFail: true});

            // When the hook mounts on it
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();

            // Then only the pages that arrived show, because the cursor moves when a request goes out, not when it lands
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);

            // When the user reaches the end of the list
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then the page that never arrived is asked for again rather than skipped
            expect(requestedOffsets()).toEqual([PAGE * 2]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
        });

        it('waits for a page that was already running instead of asking for it again', async () => {
            // Given a page another caller sent, which `search()` would answer this hook with nothing at all
            await givenSharedPage({offset: PAGE, isInFlight: true});
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();

            // Then nothing is sent while it is out, and the rows it would bring are not shown yet
            expect(mockedSearch).not.toHaveBeenCalled();
            expect(result.current.visibleRows).toHaveLength(PAGE);

            // When that page answers
            await givenSharedPage({offset: PAGE});
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then the cursor has moved past it, so the end of the list asks for the page after it
            expect(requestedOffsets()).toEqual([PAGE * 2]);
        });

        it('arms a retry when the page it was waiting for fails', async () => {
            // Given a page another caller sent while this hook mounted
            await givenSharedPage({offset: PAGE, isInFlight: true});
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();

            // When it fails
            await givenSharedPage({offset: PAGE, didFail: true});
            await flushPromises();

            // Then the end of the list asks for that same page, because a failure leaves its rows still owed
            act(() => result.current.loadMoreRows());
            await flushPromises();
            expect(requestedOffsets()).toEqual([PAGE]);
        });

        it('stops waiting for a page that never settles once an end of the list asks for it', async () => {
            // Given a snapshot left mid-request by a reload, which nothing will ever answer and no second end can outlast
            await givenSharedPage({offset: PAGE, isInFlight: true});
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();
            expect(mockedSearch).not.toHaveBeenCalled();

            // When the user reaches the end of the list
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then the hook sends that page itself, rather than leaving the list shut for the rest of the mount
            expect(requestedOffsets()).toEqual([PAGE]);
        });

        it('waits again when the page it took over turns out to be running after all', async () => {
            // Given a page another caller has out, which this hook takes over at the end of the list
            await givenSharedPage({offset: PAGE, isInFlight: true});
            mockedSearch.mockReturnValueOnce(Promise.resolve(undefined));
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then `search()` drops it as a duplicate, which the snapshot still showing that page out tells apart from a failure
            expect(requestedOffsets()).toEqual([PAGE]);

            // When the page that was running answers
            await givenSharedPage({offset: PAGE});
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // Then its rows count as this hook's own, so the end of the list asks for the page after it rather than for it again
            expect(requestedOffsets()).toEqual([PAGE, PAGE * 2]);
        });

        it('ignores the shared cursor once it has asked for a page of its own', async () => {
            // Given a hook that has sent its first page, after which report navigation pages on the same snapshot
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();
            expect(requestedOffsets()).toEqual([0]);

            // When another caller moves the shared cursor well past it
            await givenSharedPage({offset: PAGE * 4});
            await flushPromises();

            // Then the list neither grows nor skips pages, because the cursor is this hook's from here on
            expect(result.current.visibleRows).toHaveLength(PAGE);
            act(() => result.current.loadMoreRows());
            await flushPromises();
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('treats an inherited "no more results" as unknown until a page of its own answers', async () => {
            // Given a snapshot whose last session ended with the server out of rows, which live changes may have undone
            await givenSharedPage({offset: PAGE});

            // When the hook mounts on it with more rows on the device than the server had
            const {result} = renderPaging({...withDeviceRows(PAGE * 5), hasMoreServerResults: false});
            await flushPromises();

            // Then the device's rows stay behind the cap, instead of every cached row appearing at once
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
        });
    });
});
