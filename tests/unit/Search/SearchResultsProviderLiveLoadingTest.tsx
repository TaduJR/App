import {renderHook} from '@testing-library/react-native';

import {SearchResultsContext} from '@components/Search/SearchContextDefinitions';
import SearchResultsProvider from '@components/Search/SearchResultsProvider';

import React, {use} from 'react';

let mockSnapshotSearch: Record<string, unknown> = {};
jest.mock('react-native-onyx', () => ({
    __esModule: true,
    ...jest.requireActual<Record<string, unknown>>('react-native-onyx'),
    useOnyx: () => [{search: mockSnapshotSearch, data: {}}],
}));

jest.mock('@libs/SearchUIUtils', () => ({
    isTodoSearch: () => true,
    getTransactionsByReportID: () => ({}),
    getViolationsFromSearchData: () => ({}),
}));

jest.mock('@hooks/useTodoSearchResults', () => ({
    __esModule: true,
    default: () => ({data: {}, metadata: {count: 0, total: 0, currency: undefined}}),
}));

jest.mock('@components/Search/SearchContext', () => ({
    useSearchQueryContext: () => ({
        currentSearchHash: 1,
        currentSearchKey: 'approve',
        currentSearchQueryJSON: {recentSearchHash: 1},
        suggestedSearches: {},
    }),
}));

function renderProvider(snapshotSearch: Record<string, unknown>) {
    mockSnapshotSearch = snapshotSearch;
    // Read the context directly, since SearchContext is mocked for useSearchQueryContext.
    return renderHook(() => use(SearchResultsContext), {
        wrapper: ({children}: {children: React.ReactNode}) => <SearchResultsProvider>{children}</SearchResultsProvider>,
    });
}

describe('SearchResultsProvider for a live to-do search', () => {
    it('reports no loading even when a reload left the snapshot loading its first page', () => {
        const {result} = renderProvider({isLoading: true, offset: 0, hash: 1});

        expect(result.current.shouldUseLiveData).toBe(true);
        expect(result.current.currentSearchResults?.search.isLoading).toBe(false);
        expect(result.current.currentSearchResults?.search.offset).toBe(0);
    });

    it('still reports live results when the snapshot has none, so the empty state wins over a skeleton', () => {
        const {result} = renderProvider({isLoading: false, offset: 0, hash: 1});

        expect(result.current.currentSearchResults?.search.hasResults).toBe(false);
        expect(result.current.currentSearchResults?.data).toEqual({});
    });
});
