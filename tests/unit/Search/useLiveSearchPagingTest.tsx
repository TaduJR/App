import {act, renderHook, waitFor} from '@testing-library/react-native';

import useLiveSearchPaging from '@components/Search/hooks/useLiveSearchPaging';
import type {SelectedTransactionInfo, SelectedTransactions} from '@components/Search/types';

import {search} from '@libs/actions/Search';
import {buildSearchQueryJSON} from '@libs/SearchQueryUtils';

import CONST from '@src/CONST';

import type {ReactNode} from 'react';

import React, {Activity, StrictMode} from 'react';

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
            const {result} = renderPaging();

            expect(mockedSearch).toHaveBeenCalledWith(expect.objectContaining({offset: 0}));
            expect(result.current.visibleRows).toHaveLength(PAGE);

            await flushPromises();
        });

        it('shows the next page once the server answers it, with the loading indicator meanwhile', async () => {
            const {result} = renderPaging();
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            act(() => result.current.loadMoreRows());

            expect(result.current.visibleRows).toHaveLength(PAGE);
            expect(result.current.isLoadingMore).toBe(true);
            expect(requestedOffsets()).toEqual([0, PAGE]);

            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
            expect(result.current.isLoadingMore).toBe(false);
        });

        it('counts an end of the list once per change to its rows, and asks the server for one page at a time', async () => {
            const {result} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0, PAGE]);

            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
        });

        it('stops asking when the pages it gets leave a list the device cannot fill unchanged', async () => {
            const {result} = renderPaging(withDeviceRows(20));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            // FlashList reports an end for each new rows array an answer brings, even with the same rows.
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('keeps an end of the list reached while the first page is on its way', async () => {
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result} = renderPaging();

            act(() => result.current.loadMoreRows());

            expect(result.current.visibleRows).toHaveLength(PAGE);

            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
        });

        it('asks for the next page after the first, for an end reached while it was on its way with no rows to spare', async () => {
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result} = renderPaging(withDeviceRows(PAGE));

            act(() => result.current.loadMoreRows());
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('keeps an end of the list reached on a short list while the first page is on its way', async () => {
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result} = renderPaging(withDeviceRows(3));

            act(() => result.current.loadMoreRows());
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE]));
            await flushPromises();
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('asks for the next page at the end the answer brings, when the device has fewer rows than that page', async () => {
            const {result} = renderPaging(withDeviceRows(PAGE + 10));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            act(() => result.current.loadMoreRows());
            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            expect(result.current.visibleRows).toHaveLength(PAGE + 10);
            act(() => result.current.loadMoreRows());

            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]));
            await flushPromises();
            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);
        });

        it('ignores ends the list reports again on the same rows, however many rows the device holds', async () => {
            const {result} = renderPaging(withDeviceRows(PAGE * 5));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('asks for more once the server has answered every row asked for, even when the device holds fewer', async () => {
            const {result} = renderPaging(withDeviceRows(3));
            await flushPromises();

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0, PAGE]);

            await flushPromises();
        });

        it('ignores an end of the list reached while Search holds its rows back', async () => {
            const {result, rerender} = renderPaging();
            await flushPromises();

            rerender({areRowsDeferred: true, deviceRows: [], deviceFilteredData: []});
            act(() => result.current.loadMoreRows());
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0]);
            expect(result.current.visibleRows).toHaveLength(PAGE);
        });

        it('counts an end on the same rows once the server has more to give again', async () => {
            const {result, rerender} = renderPaging({...withDeviceRows(PAGE), hasMoreServerResults: false});
            await flushPromises();

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0]);

            rerender({...withDeviceRows(PAGE), hasMoreServerResults: true});
            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('stops asking once the device and the server are both exhausted', async () => {
            const {result, rerender} = renderPaging({...withDeviceRows(PAGE), hasMoreServerResults: false});
            await flushPromises();

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0]);

            rerender({...withDeviceRows(PAGE * 2), hasMoreServerResults: false});
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
            expect(requestedOffsets()).toEqual([0]);
        });

        it('shows every row the device holds without asking, once the server reports no more pages', async () => {
            const {result} = renderPaging({hasMoreServerResults: false});

            // Until a page answers, the snapshot's `false` may be stale.
            expect(result.current.visibleRows).toHaveLength(PAGE);

            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
            expect(result.current.visibleFilteredData).toHaveLength(PAGE * 3);

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0]);
            expect(result.current.isLoadingMore).toBe(false);
        });
    });

    describe('the rows on screen', () => {
        it('hands selection only the rendered rows, in the order they render', async () => {
            const reports = deviceRowsOf(PAGE + 5);
            // Selection's rows arrive unsorted.
            const {result} = renderPaging({deviceRows: reports, deviceFilteredData: [...reports].reverse()});
            await flushPromises();

            const renderedKeys = reports.slice(0, PAGE).map((report) => report.keyForList);
            expect(result.current.visibleRows.map((row) => row.keyForList)).toEqual(renderedKeys);
            expect(result.current.visibleFilteredData.map((row) => row.keyForList)).toEqual(renderedKeys);
        });

        it('passes both lists through untouched while every row fits', async () => {
            const rows = deviceRowsOf(PAGE);
            const sections = [...rows].reverse();
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: sections});
            await flushPromises();

            expect(result.current.visibleRows).toBe(rows);
            expect(result.current.visibleFilteredData).toBe(sections);
        });

        it('keeps the rendered rows across a render that changes nothing they depend on', async () => {
            const {result, rerender} = renderPaging();
            await flushPromises();
            const firstRows = result.current.visibleRows;
            const firstSelectionRows = result.current.visibleFilteredData;

            rerender({shouldCalculateTotalsOnFirstPage: true});

            expect(result.current.visibleRows).toBe(firstRows);
            expect(result.current.visibleFilteredData).toBe(firstSelectionRows);
        });

        it('keeps rows it showed offline once the connection returns, before their pages answer', async () => {
            const {result, rerender} = renderPaging({isOffline: true});
            act(() => result.current.loadMoreRows());

            expect(result.current.visibleRows).toHaveLength(PAGE * 2);

            mockedSearch.mockReturnValue(holdAnswer().promise);
            rerender({isOffline: false});

            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
        });

        it('gives the place of a report being deleted online to the next report the device holds', async () => {
            const reports = deviceRowsOf(PAGE * 3);
            const rows = [...reports.slice(0, PAGE).map(markDeleted), ...reports.slice(PAGE)];
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: rows});
            await flushPromises();

            expect(result.current.visibleRows).toEqual(rows.slice(0, PAGE * 2));
            expect(result.current.visibleFilteredData).toEqual(rows.slice(0, PAGE * 2));
        });

        it('passes both lists through untouched while every shown report fits, however many are being deleted', async () => {
            const reports = deviceRowsOf(PAGE + 10);
            const rows = [...reports.slice(0, 10).map(markDeleted), ...reports.slice(10)];
            const sections = [...rows].reverse();
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: sections});
            await flushPromises();

            expect(result.current.visibleRows).toBe(rows);
            expect(result.current.visibleFilteredData).toBe(sections);
        });

        it('counts a report being deleted offline, where it shows struck through', async () => {
            const reports = deviceRowsOf(PAGE * 3);
            const rows = [...reports.slice(0, PAGE).map(markDeleted), ...reports.slice(PAGE)];
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: rows, isOffline: true});

            expect(result.current.visibleRows).toEqual(rows.slice(0, PAGE));
        });

        it('renders every row the device holds for a snapshot-backed search', async () => {
            const {result} = renderPaging({isLiveSearch: false});

            expect(result.current.visibleRows).toBe(baseProps.deviceRows);
            expect(result.current.visibleFilteredData).toBe(baseProps.deviceFilteredData);

            await flushPromises();
        });
    });

    describe('a selected row', () => {
        it('stays on screen when reports arriving above push it past the limit', async () => {
            const reports = deviceRowsOf(PAGE + 5);
            const lastShown = reports.at(PAGE - 1)?.keyForList ?? '';
            // A report is selected through its expenses.
            const {result, rerender} = renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf(`${lastShown}-expense`)});
            await flushPromises();

            const withNewReports = [...reportsOf(3, 'new'), ...reports];
            rerender({deviceRows: withNewReports, deviceFilteredData: withNewReports});

            expect(result.current.visibleRows).toHaveLength(PAGE + 3);
            expect(result.current.visibleRows.at(-1)?.keyForList).toBe(lastShown);
            expect(result.current.visibleFilteredData.at(-1)?.keyForList).toBe(lastShown);
        });

        it('stays on screen once its tick is cleared', async () => {
            const reports = deviceRowsOf(PAGE + 5);
            const {result, rerender} = renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf(`report${PAGE + 1}-expense`)});
            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE + 2);

            rerender({selectedTransactions: {}});

            expect(result.current.visibleRows).toHaveLength(PAGE + 2);
        });

        it('keeps an empty report on screen, which holds its tick under its own key', async () => {
            const reports = [...deviceRowsOf(PAGE), buildReportGroup(PAGE, 'empty')];
            const {result} = renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf('empty')});
            await flushPromises();

            expect(result.current.visibleRows.at(-1)?.keyForList).toBe('empty');
        });

        it('is not kept on screen by a tick that is not selected', async () => {
            const reports = deviceRowsOf(PAGE + 5);
            const clearedTick = {[`report${PAGE + 1}-expense`]: createMock<SelectedTransactionInfo>({isSelected: false})};
            const {result} = renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: clearedTick});
            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE);
        });

        it('does not make the server owe more pages', async () => {
            const reports = deviceRowsOf(PAGE + 5);
            renderPaging({deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf(`report${PAGE + 1}-expense`)});
            await flushPromises();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0]);
        });

        it('ends the list at it when reports being deleted sit above it', async () => {
            const reports = deviceRowsOf(PAGE * 3);
            const rows = [...reports.slice(0, 10).map(markDeleted), ...reports.slice(10)];
            const selectedKey = rows.at(PAGE + 20)?.keyForList ?? '';
            const {result} = renderPaging({deviceRows: rows, deviceFilteredData: rows, selectedTransactions: selectionOf(selectedKey)});
            await flushPromises();

            // The 61st shown row, below the 10 hidden ones.
            expect(result.current.visibleRows.at(-1)?.keyForList).toBe(selectedKey);
        });

        it('lets the list grow past it at the next end of the list', async () => {
            const {result} = renderPaging({selectedTransactions: selectionOf(`report${PAGE + 20}-expense`)});
            await flushPromises();

            act(() => result.current.loadMoreRows());

            expect(result.current.visibleRows).toHaveLength(PAGE * 2 + 21);
            await flushPromises();
        });

        it('does not take rows held back while Search settles for rows the device lacks', async () => {
            const {result, rerender} = renderPaging({selectedTransactions: selectionOf(`report${PAGE + 20}-expense`)});
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            rerender({areRowsDeferred: true, deviceRows: [], deviceFilteredData: []});
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
        });

        it('asks the server for one page per end once the list has run past it', async () => {
            const {result} = renderPaging({...withDeviceRows(PAGE * 5), selectedTransactions: selectionOf(`report${PAGE * 2}-expense`)});
            await flushPromises();

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE * 3 + 1);
            expect(requestedOffsets()).toEqual([0, PAGE]);

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);
        });

        it('asks the server for the rows the device lacks once the list has run past it', async () => {
            const secondPage = holdAnswer();
            const {result, rerender} = renderPaging({...withDeviceRows(PAGE + 21), selectedTransactions: selectionOf(`report${PAGE + 20}-expense`)});
            await flushPromises();
            mockedSearch.mockReturnValueOnce(secondPage.promise);

            act(() => result.current.loadMoreRows());

            expect(result.current.isLoadingMore).toBe(true);

            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);

            rerender(withDeviceRows(PAGE * 4));
            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2, PAGE * 3]);
        });

        it('does not change the rows of a snapshot-backed search', async () => {
            const reports = deviceRowsOf(PAGE + 5);
            const {result} = renderPaging({isLiveSearch: false, deviceRows: reports, deviceFilteredData: reports, selectedTransactions: selectionOf(`report${PAGE + 1}-expense`)});
            await flushPromises();

            expect(result.current.visibleRows).toBe(reports);
            expect(mockedSearch).not.toHaveBeenCalled();
        });
    });

    describe('a highlighted row', () => {
        function withHighlightOn(reports: ReturnType<typeof reportsOf>, key: string) {
            return reports.map((report) => (report.keyForList === key ? {...report, shouldAnimateInHighlight: true} : report));
        }

        it('stays on screen when a new expense lands in a report past the limit', async () => {
            const reports = withHighlightOn(deviceRowsOf(PAGE + 10), `report${PAGE + 5}`);
            const {result} = renderPaging({deviceRows: reports, deviceFilteredData: reports});
            await flushPromises();

            expect(result.current.visibleRows.findIndex((row) => row.keyForList === `report${PAGE + 5}`)).toBe(PAGE + 5);
            expect(result.current.visibleRows).toHaveLength(PAGE + 6);
            expect(requestedOffsets()).toEqual([0]);
        });

        it('stays on screen once the highlight ends', async () => {
            const reports = deviceRowsOf(PAGE + 10);
            const highlighted = withHighlightOn(reports, `report${PAGE + 5}`);
            const {result, rerender} = renderPaging({deviceRows: highlighted, deviceFilteredData: highlighted});
            await flushPromises();

            rerender({deviceRows: reports, deviceFilteredData: reports});

            expect(result.current.visibleRows).toHaveLength(PAGE + 6);
        });
    });

    describe('the pages the server owes', () => {
        it('asks with the query, key and first-page totals flag it was given', async () => {
            renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            expect(mockedSearch).toHaveBeenCalledWith({queryJSON: baseProps.queryJSON, searchKey: CONST.SEARCH.SEARCH_KEYS.SUBMIT, offset: 0, shouldCalculateTotals: true, isLoading: false});
        });

        it('asks for totals past the first page only when every page needs them', async () => {
            const {result} = renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: false}));
        });

        it('sends each page with the totals flag current when it goes out', async () => {
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result, rerender} = renderPaging();

            rerender({shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            act(() => result.current.loadMoreRows());

            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));

            await flushPromises();
        });

        it('asks again for the last page it has once the connection is back, since what it said may have changed', async () => {
            const {result, rerender} = renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            rerender({isOffline: true});
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: false}));

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE * 2]);
        });

        it('asks again for the first page, with its totals, once the connection is back before any other page', async () => {
            const {rerender} = renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            rerender({isOffline: true});
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, 0]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: 0, shouldCalculateTotals: true}));
        });

        it('asks again for the last page it has, with totals, once every matching report is selected', async () => {
            const {result, rerender} = renderPaging();
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await flushPromises();
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));
        });

        it('still asks for the last page when one sent before every matching report was selected answers first', async () => {
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();
            const thirdPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(thirdPage.promise);
            act(() => result.current.loadMoreRows());

            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                thirdPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2, PAGE * 2]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE * 2, shouldCalculateTotals: true}));
        });

        it('still asks for the last page with totals when every matching report is selected while a reconnect refresh is on its way', async () => {
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();
            const refresh = holdAnswer();
            mockedSearch.mockReturnValueOnce(refresh.promise);

            rerender({isOffline: true});
            rerender();
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: false}));

            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                refresh.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));
        });

        it('asks again for the first page, with its totals, once every matching report is selected, since live changes may have made its count stale', async () => {
            const {rerender} = renderPaging({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await flushPromises();
            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, 0]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: 0, shouldCalculateTotals: true}));
        });

        it('does not ask for the first page twice when every matching report is selected while it is on its way', async () => {
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {rerender} = renderPaging({shouldCalculateTotalsOnFirstPage: true});

            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0]);
        });

        it('asks for the last page with totals once the page on its way answers, when every matching report is selected while it loads', async () => {
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            rerender({shouldCalculateTotalsOnFirstPage: true, shouldCalculateTotalsOnLaterPages: true});
            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));
        });

        it('asks for a totals refresh that failed again once paging is unblocked, and not before', async () => {
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

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            // Returning to the screen lifts the block.
            rerender({...allMatching, isFocused: false});
            rerender(allMatching);
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE]);
            expect(mockedSearch).toHaveBeenLastCalledWith(expect.objectContaining({offset: PAGE, shouldCalculateTotals: true}));
        });

        it('holds the refresh a reconnect owes while a failed page blocks paging, and lets a fresh page settle it', async () => {
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            rerender({isOffline: true});
            rerender();
            await act(async () => {
                secondPage.answer(500);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);

            // Returning to the screen lifts the block.
            rerender({isFocused: false});
            rerender();
            await flushPromises();
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);
        });

        it('asks for a refresh a reconnect owes again once paging is unblocked, when it failed', async () => {
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();
            mockedSearch.mockReturnValueOnce(Promise.resolve(500));

            rerender({isOffline: true});
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            // Returning to the screen lifts the block.
            rerender({isFocused: false});
            rerender();
            await flushPromises();
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE]);
        });

        it('sends nothing once its search stops being a to-do search', async () => {
            const {result, rerender} = renderPaging();
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();
            mockedSearch.mockClear();

            rerender({isLiveSearch: false, isOffline: true});
            rerender({isLiveSearch: false});
            await flushPromises();

            expect(mockedSearch).not.toHaveBeenCalled();
        });

        it('waits for the screen to be focused before asking for anything', async () => {
            const {result, rerender} = renderPaging({isFocused: false});
            await flushPromises();

            act(() => result.current.loadMoreRows());

            expect(mockedSearch).not.toHaveBeenCalled();
            expect(result.current.visibleRows).toHaveLength(PAGE);

            rerender({isFocused: true});
            await flushPromises();

            expect(requestedOffsets()).toEqual([0]);
        });

        it('keeps a page answered while an unrelated prop changed, rather than asking for it twice', async () => {
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result, rerender} = renderPaging(withDeviceRows(PAGE * 4));

            rerender({shouldCalculateTotalsOnFirstPage: true});
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            expect(requestedOffsets()).toEqual([0]);

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0, PAGE]);

            await flushPromises();
        });

        it('asks only for the page it owes once the connection is back, then one page per end', async () => {
            const {result, rerender} = renderPaging({isOffline: true, ...withDeviceRows(PAGE * 4)});
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());

            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
            expect(mockedSearch).not.toHaveBeenCalled();

            rerender({isOffline: false});
            await waitFor(() => expect(requestedOffsets()).toEqual([0]));
            await flushPromises();

            expect(requestedOffsets()).toEqual([0]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 4);
        });

        it('stops asking for the pages it owes once the server reports it has no more', async () => {
            const {result, rerender} = renderPaging({isOffline: true});
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            rerender({isOffline: false});

            rerender({isOffline: false, hasMoreServerResults: false});
            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();

            expect(requestedOffsets()).toEqual([0]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
        });

        it('keeps paging after a cover and reveal cycle, which cleans up its effects and runs them again', async () => {
            // StrictMode runs the cleanup-and-rerun cycle a covered screen goes through, with refs kept.
            const {result} = renderHook((props: PagingProps) => useLiveSearchPaging(props), {initialProps: {...baseProps, ...withDeviceRows(PAGE * 4)}, wrapper: StrictMode});
            await flushPromises();

            act(() => result.current.loadMoreRows());
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE * 2]);
        });

        it('counts a page that answers while the list is hidden', async () => {
            let activityMode: 'visible' | 'hidden' = 'visible';
            function ActivityWrapper({children}: {children: ReactNode}) {
                return <Activity mode={activityMode}>{children}</Activity>;
            }
            const {result, rerender} = renderHook((props: PagingProps) => useLiveSearchPaging(props), {initialProps: {...baseProps, ...withDeviceRows(PAGE * 4)}, wrapper: ActivityWrapper});
            await flushPromises();
            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            // Hiding destroys Effects but keeps state.
            activityMode = 'hidden';
            rerender({...baseProps, ...withDeviceRows(PAGE * 4)});
            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            activityMode = 'visible';
            rerender({...baseProps, ...withDeviceRows(PAGE * 4)});
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
        });

        it('reports the last page the server answered, which report navigation pages on from', async () => {
            const {result} = renderPaging();
            await flushPromises();

            expect(result.current.lastPageOffset).toBe(0);

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(result.current.lastPageOffset).toBe(PAGE);
        });

        it('does nothing at all for a snapshot-backed search', async () => {
            const {result} = renderPaging({isLiveSearch: false});

            act(() => result.current.loadMoreRows());

            expect(mockedSearch).not.toHaveBeenCalled();

            await flushPromises();
        });

        it('adds no render of its own to a snapshot-backed search when focus, the connection or the selection changes', () => {
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

            rerender({...initialProps, isOffline: true});
            rerender({...initialProps, isFocused: false});
            rerender({...initialProps, shouldCalculateTotalsOnLaterPages: true});

            expect(onRender).toHaveBeenCalledTimes(3);
        });
    });

    describe('while offline', () => {
        it('shows rows the device holds, and asks for the pages it owes once the connection is back', async () => {
            const {result, rerender} = renderPaging({isOffline: true});

            act(() => result.current.loadMoreRows());

            expect(mockedSearch).not.toHaveBeenCalled();
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);

            rerender({isOffline: false});

            await waitFor(() => expect(requestedOffsets()).toEqual([0]));
            await flushPromises();
            expect(requestedOffsets()).toEqual([0]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
        });

        it('shows rows the device holds while a page that started online is still pending', async () => {
            // A search waiting on the write queue can't settle offline.
            mockedSearch.mockReturnValue(holdAnswer().promise);
            const {result, rerender} = renderPaging();

            rerender({isOffline: true});
            act(() => result.current.loadMoreRows());

            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
            expect(requestedOffsets()).toEqual([0]);
        });

        it('asks for the page an end of the list wanted once the connection is back, when the device had no rows to spare', async () => {
            const {result, rerender} = renderPaging({...withDeviceRows(PAGE), isOffline: true});

            act(() => result.current.loadMoreRows());
            rerender({isOffline: false});

            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE]));
        });

        it('keeps an end of the list reached offline on a short list, and asks for that page after the one it owes', async () => {
            const {result, rerender} = renderPaging({...withDeviceRows(3), isOffline: true});

            act(() => result.current.loadMoreRows());
            rerender({isOffline: false});

            await waitFor(() => expect(requestedOffsets()).toEqual([0, PAGE]));
            await flushPromises();
            expect(requestedOffsets()).toEqual([0, PAGE]);
        });
    });

    describe('a page that goes unanswered', () => {
        it('is not asked for again until the list reaches its end, while the rows the device holds show', async () => {
            const {result, rerender} = renderPaging();
            await flushPromises();
            mockedSearch.mockReturnValue(Promise.resolve(500));

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE * 2);

            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));
            rerender({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            expect(mockedSearch).not.toHaveBeenCalled();

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([PAGE]);
            expect(result.current.visibleRows).toHaveLength(PAGE * 2);

            await flushPromises();
        });

        it('is asked for again at the next end of the list, even when no rows could show', async () => {
            const {result} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();
            mockedSearch.mockReturnValue(Promise.resolve(500));

            act(() => result.current.loadMoreRows());
            await flushPromises();
            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([PAGE]);

            await flushPromises();
            await flushPromises();

            expect(requestedOffsets()).toEqual([PAGE]);
        });

        it('is asked for again at one end of the list, not at every end on the same rows', async () => {
            const {result, rerender} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();
            mockedSearch.mockReturnValue(Promise.resolve(500));

            act(() => result.current.loadMoreRows());
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            // Each failure can bring a new rows array, and with it another end.
            act(() => result.current.loadMoreRows());
            await flushPromises();
            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            rerender({isFocused: false});
            rerender({isFocused: true});
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE, PAGE]);
        });

        it('is asked for again after a failed first page, whatever a stale snapshot claims', async () => {
            mockedSearch.mockReturnValue(Promise.resolve(500));
            const {result} = renderPaging({hasMoreServerResults: false});
            await flushPromises();
            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0]);

            await flushPromises();
            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
        });

        it('treats a page search() did not send as unanswered, and asks for it again at the next end', async () => {
            const {result} = renderPaging();
            await flushPromises();
            // What search() returns while a delete finishes, or when the same page is already in flight.
            mockedSearch.mockReturnValueOnce(undefined);

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
            expect(result.current.isLoadingMore).toBe(false);

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            await flushPromises();
        });

        it('treats a search that throws while it is being built as unanswered, rather than letting the error escape', async () => {
            const {result} = renderPaging();
            await flushPromises();
            mockedSearch.mockImplementationOnce(() => {
                throw new Error('query could not be built');
            });

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
            expect(result.current.isLoadingMore).toBe(false);

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            await flushPromises();
        });

        it('treats a request that fails outright as unanswered', async () => {
            const {result} = renderPaging();
            await flushPromises();
            mockedSearch.mockReturnValueOnce(Promise.reject(new Error('request could not be sent')));

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(result.current.visibleRows).toHaveLength(PAGE * 2);
            expect(result.current.isLoadingMore).toBe(false);

            act(() => result.current.loadMoreRows());

            expect(requestedOffsets()).toEqual([0, PAGE, PAGE]);

            await flushPromises();
        });

        it('is asked for again on reconnect when a dropped connection lost it, and once more on the next reconnect only as a refresh', async () => {
            // What search() resolves with when the request fails at the network level.
            mockedSearch.mockReturnValue(Promise.resolve(undefined));
            const {rerender} = renderPaging();
            await flushPromises();
            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            rerender({isOffline: true});
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0]);

            rerender({isOffline: true});
            rerender();
            await flushPromises();
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, 0]);
        });

        it('is asked for again when the screen is focused again', async () => {
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.EXP_ERROR));
            const {rerender} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            rerender({isFocused: false});
            rerender();
            await flushPromises();

            expect(requestedOffsets()).toEqual([0, 0]);
        });

        it('is asked for again on the next reconnect after a server error, not on every render before it', async () => {
            mockedSearch.mockReturnValue(Promise.resolve(500));
            const {rerender} = renderPaging();
            await flushPromises();
            mockedSearch.mockClear();
            mockedSearch.mockReturnValue(Promise.resolve(CONST.JSON_CODE.SUCCESS));

            rerender({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            expect(mockedSearch).not.toHaveBeenCalled();

            rerender({shouldCalculateTotalsOnFirstPage: true, isOffline: true});
            rerender({shouldCalculateTotalsOnFirstPage: true});
            await flushPromises();

            expect(requestedOffsets()).toEqual([0]);
        });
    });

    describe('the loading indicator', () => {
        it('shows only once the list has reached an end', async () => {
            const {result} = renderPaging(withDeviceRows(PAGE * 4));

            expect(result.current.isLoadingMore).toBe(false);
            await flushPromises();
            expect(result.current.isLoadingMore).toBe(false);

            const secondPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            expect(result.current.isLoadingMore).toBe(true);

            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });

            expect(result.current.isLoadingMore).toBe(false);
        });

        it('shows at an end reached while the first page is still on its way, but not under a short list on mount', async () => {
            const firstPage = holdAnswer();
            mockedSearch.mockReturnValueOnce(firstPage.promise);
            const {result} = renderPaging(withDeviceRows(30));

            expect(result.current.isLoadingMore).toBe(false);

            act(() => result.current.loadMoreRows());

            expect(result.current.isLoadingMore).toBe(true);

            await act(async () => {
                firstPage.answer(CONST.JSON_CODE.SUCCESS);
            });
            await flushPromises();
        });

        it('stays hidden while offline, where a page is only owed rather than on its way', async () => {
            const {result, rerender} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();

            rerender({isOffline: true});
            act(() => result.current.loadMoreRows());

            expect(result.current.isLoadingMore).toBe(false);
        });

        it('stays hidden while Search holds its rows back', async () => {
            const secondPage = holdAnswer();
            const {result, rerender} = renderPaging();
            await flushPromises();
            mockedSearch.mockReturnValueOnce(secondPage.promise);
            act(() => result.current.loadMoreRows());

            rerender({areRowsDeferred: true, deviceRows: [], deviceFilteredData: []});

            expect(result.current.isLoadingMore).toBe(false);

            await act(async () => {
                secondPage.answer(CONST.JSON_CODE.SUCCESS);
            });
        });

        it('stays hidden once a page goes unanswered', async () => {
            const {result} = renderPaging(withDeviceRows(PAGE));
            await flushPromises();
            mockedSearch.mockReturnValue(Promise.resolve(500));

            act(() => result.current.loadMoreRows());
            await flushPromises();

            expect(result.current.isLoadingMore).toBe(false);
        });

        it('stays hidden while the pages it fetches sit behind rows already on screen', async () => {
            const {result, rerender} = renderPaging();
            await flushPromises();
            rerender({isOffline: true});
            act(() => result.current.loadMoreRows());
            act(() => result.current.loadMoreRows());
            mockedSearch.mockReturnValue(holdAnswer().promise);

            rerender({isOffline: false});

            expect(result.current.visibleRows).toHaveLength(PAGE * 3);
            expect(result.current.isLoadingMore).toBe(false);
        });
    });
});
