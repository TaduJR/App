import {act, renderHook} from '@testing-library/react-native';

import {LocaleContextProvider} from '@components/LocaleContextProvider';
import useFormErrorManagement from '@components/MoneyRequestConfirmationList/hooks/useFormErrorManagement';

import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import type * as OnyxTypes from '@src/types/onyx';
import type {CurrentUserPersonalDetails} from '@src/types/onyx/PersonalDetails';

import type * as ReactNavigationModule from '@react-navigation/native';

import React from 'react';
import Onyx from 'react-native-onyx';

import createMock from '../../utils/createMock';
import waitForBatchedUpdatesWithAct from '../../utils/waitForBatchedUpdatesWithAct';

jest.mock('@react-navigation/native', () => {
    const actual = jest.requireActual<typeof ReactNavigationModule>('@react-navigation/native');
    return {
        ...actual,
        useIsFocused: () => true,
    };
});

type Params = Parameters<typeof useFormErrorManagement>[0];

const baseParams: Params = {
    transaction: createMock<OnyxTypes.Transaction>({transactionID: 'txn1', amount: 100, merchant: 'Coffee', comment: {}}),
    transactionReport: undefined,
    iouMerchant: 'Coffee',
    iouCategory: '',
    iouAttendees: [],
    policy: undefined,
    policyTags: undefined,
    policyCategories: undefined,
    currentUserPersonalDetails: {accountID: 1} as CurrentUserPersonalDetails,
    isEditingSplitBill: false,
    isPolicyExpenseChat: false,
    isScanRequest: false,
    shouldShowMerchant: true,
    hasSmartScanFailed: false,
    didConfirmSplit: false,
    routeError: undefined,
    isTypeSplit: false,
    shouldShowReadOnlySplits: false,
    isDistanceRequest: false,
};

// A manual draft the user never typed a merchant into: `initMoneyRequest` seeds it with the "Expense" placeholder.
const placeholderMerchantTransaction = createMock<OnyxTypes.Transaction>({
    transactionID: 'txn1',
    amount: 100,
    merchant: CONST.TRANSACTION.DEFAULT_MERCHANT,
    isMerchantSet: false,
    comment: {},
});

const placeholderMerchantParams: Partial<Params> = {
    transaction: placeholderMerchantTransaction,
    iouMerchant: CONST.TRANSACTION.DEFAULT_MERCHANT,
};

function Wrapper({children}: {children: React.ReactNode}) {
    return <LocaleContextProvider>{children}</LocaleContextProvider>;
}

describe('useFormErrorManagement', () => {
    beforeAll(async () => {
        Onyx.init({keys: ONYXKEYS});
        await Onyx.set(ONYXKEYS.NVP_PREFERRED_LOCALE, CONST.LOCALES.DEFAULT);
        return waitForBatchedUpdatesWithAct();
    });

    it('shouldDisplayFieldError is false when not editing a split bill', () => {
        const {result} = renderHook(() => useFormErrorManagement(baseParams), {wrapper: Wrapper});
        expect(result.current.shouldDisplayFieldError).toBe(false);
    });

    it('shouldDisplayFieldError is true when editing split bill with smartScan failure and missing fields', () => {
        const {result} = renderHook(
            () =>
                useFormErrorManagement({
                    ...baseParams,
                    isEditingSplitBill: true,
                    hasSmartScanFailed: true,
                    transaction: createMock<OnyxTypes.Transaction>({transactionID: 'txn1', amount: 0, merchant: '', comment: {}, receipt: {state: CONST.IOU.RECEIPT_STATE.SCAN_FAILED}}),
                    transactionReport: createMock<OnyxTypes.Report>({type: CONST.REPORT.TYPE.IOU}),
                }),
            {wrapper: Wrapper},
        );
        expect(result.current.shouldDisplayFieldError).toBe(true);
    });

    it('isMerchantRequired is true only for policyExpenseChat with non-scan request and shouldShowMerchant', () => {
        const {result: required} = renderHook(() => useFormErrorManagement({...baseParams, isPolicyExpenseChat: true, isScanRequest: false, shouldShowMerchant: true}), {wrapper: Wrapper});
        const {result: notRequired} = renderHook(
            () => useFormErrorManagement({...baseParams, isPolicyExpenseChat: true, isScanRequest: true, shouldShowMerchant: true, isEditingSplitBill: false}),
            {wrapper: Wrapper},
        );
        expect(required.current.isMerchantRequired).toBe(true);
        expect(notRequired.current.isMerchantRequired).toBe(false);
    });

    it('clearFormErrors only clears the error when it matches the provided list', async () => {
        const {result} = renderHook(() => useFormErrorManagement(baseParams), {wrapper: Wrapper});
        act(() => result.current.setFormError('iou.error.invalidMerchant'));
        expect(result.current.formError).toBe('iou.error.invalidMerchant');

        // Non-matching list does not clear
        act(() => result.current.clearFormErrors(['iou.error.invalidCategoryLength']));
        expect(result.current.formError).toBe('iou.error.invalidMerchant');

        // Matching list clears
        act(() => result.current.clearFormErrors(['iou.error.invalidMerchant']));
        expect(result.current.formError).toBe('');
    });

    it('errorMessage returns routeError when present', () => {
        const {result} = renderHook(() => useFormErrorManagement({...baseParams, routeError: 'route.error.unreachable'}), {wrapper: Wrapper});
        expect(result.current.errorMessage).toBe('route.error.unreachable');
    });

    it('errorMessage returns undefined for violations.missingAttendees on non-split flows', async () => {
        const {result} = renderHook(() => useFormErrorManagement(baseParams), {wrapper: Wrapper});
        act(() => result.current.setFormError('violations.missingAttendees'));
        expect(result.current.errorMessage).toBeUndefined();
    });

    it('errorMessage leaves out the invalid amount error the amount input already shows', () => {
        // Given an edited split, whose amount input flags an invalid amount through the form error as the user types
        const {result} = renderHook(() => useFormErrorManagement(baseParams), {wrapper: Wrapper});

        // When that error is set
        act(() => result.current.setFormError('common.error.invalidAmount'));

        // Then the footer doesn't repeat it under the button
        expect(result.current.errorMessage).toBeUndefined();
    });

    it('errorMessage still shows the invalid amount error for a distance request (no inline surface)', () => {
        const {result} = renderHook(() => useFormErrorManagement({...baseParams, isDistanceRequest: true}), {wrapper: Wrapper});
        act(() => result.current.setFormError('common.error.invalidAmount'));
        expect(result.current.errorMessage).toBeDefined();
    });

    const splitParams: Params = {...baseParams, isTypeSplit: true, shouldShowReadOnlySplits: false};

    it('suppresses the duplicate footer invalid amount error on an editable split (#96565)', () => {
        jest.useFakeTimers();
        try {
            const {result} = renderHook(() => useFormErrorManagement(splitParams), {wrapper: Wrapper});
            act(() => result.current.setFormError('common.error.invalidAmount'));
            act(() => jest.advanceTimersByTime(CONST.TIMING.USE_DEBOUNCED_STATE_DELAY + 1));

            // The debounce has settled, so an undefined message is real suppression rather than lag.
            expect(result.current.debouncedFormError).toBe('common.error.invalidAmount');
            expect(result.current.errorMessage).toBeUndefined();
        } finally {
            jest.useRealTimers();
        }
    });

    it('keeps a corrected split error hidden while the debounce is still holding the old value (#96565)', () => {
        jest.useFakeTimers();
        try {
            const {result} = renderHook(() => useFormErrorManagement(splitParams), {wrapper: Wrapper});

            // Given an editable split that failed confirmation with an invalid amount
            act(() => result.current.setFormError('common.error.invalidAmount'));
            act(() => jest.advanceTimersByTime(CONST.TIMING.USE_DEBOUNCED_STATE_DELAY + 1));
            expect(result.current.errorMessage).toBeUndefined();

            // When the user types a valid amount, clearing the live error while the debounced one still lags
            act(() => result.current.setFormError(''));
            expect(result.current.formError).toBe('');
            expect(result.current.debouncedFormError).toBe('common.error.invalidAmount');

            // Then the footer error must not pop back in for the length of the debounce
            expect(result.current.errorMessage).toBeUndefined();
            act(() => jest.advanceTimersByTime(CONST.TIMING.USE_DEBOUNCED_STATE_DELAY + 1));
            expect(result.current.errorMessage).toBeUndefined();
        } finally {
            jest.useRealTimers();
        }
    });

    it('still shows footer errors that have no inline surface on an editable split', () => {
        jest.useFakeTimers();
        try {
            const {result} = renderHook(() => useFormErrorManagement(splitParams), {wrapper: Wrapper});
            act(() => result.current.setFormError('iou.error.noParticipantSelected'));
            act(() => jest.advanceTimersByTime(CONST.TIMING.USE_DEBOUNCED_STATE_DELAY + 1));

            expect(result.current.errorMessage).toBeDefined();
        } finally {
            jest.useRealTimers();
        }
    });

    it('treats the placeholder merchant of an untouched draft as empty, so it is only invalid while a merchant is required', () => {
        const {result: required} = renderHook(() => useFormErrorManagement({...baseParams, ...placeholderMerchantParams, isPolicyExpenseChat: true}), {wrapper: Wrapper});
        const {result: notRequired} = renderHook(() => useFormErrorManagement({...baseParams, ...placeholderMerchantParams, isPolicyExpenseChat: false}), {wrapper: Wrapper});

        expect(required.current.isMerchantFieldValid).toBe(false);
        expect(notRequired.current.isMerchantFieldValid).toBe(true);
    });

    it('keeps a placeholder merchant the user typed themselves invalid', () => {
        const {result} = renderHook(
            () =>
                useFormErrorManagement({
                    ...baseParams,
                    ...placeholderMerchantParams,
                    transaction: {...placeholderMerchantTransaction, isMerchantSet: true},
                    isPolicyExpenseChat: false,
                }),
            {wrapper: Wrapper},
        );

        expect(result.current.isMerchantFieldValid).toBe(false);
    });

    it('leaves the merchant optional on a scan the user has started filling in, since a blank field is still scanned', () => {
        const scanParams: Partial<Params> = {
            isScanRequest: true,
            isPolicyExpenseChat: false,
            iouMerchant: CONST.TRANSACTION.PARTIAL_TRANSACTION_MERCHANT,
        };
        const scanDraft = {
            transactionID: 'txn1',
            amount: 0,
            merchant: CONST.TRANSACTION.PARTIAL_TRANSACTION_MERCHANT,
            comment: {},
            iouRequestType: CONST.IOU.REQUEST_TYPE.SCAN,
        };

        const {result: untouched} = renderHook(() => useFormErrorManagement({...baseParams, ...scanParams, transaction: createMock<OnyxTypes.Transaction>(scanDraft)}), {
            wrapper: Wrapper,
        });
        const {result: amountEntered} = renderHook(
            () => useFormErrorManagement({...baseParams, ...scanParams, transaction: createMock<OnyxTypes.Transaction>({...scanDraft, amount: 1000, isAmountSet: true})}),
            {wrapper: Wrapper},
        );

        expect(untouched.current.isMerchantRequired).toBe(false);
        expect(amountEntered.current.isMerchantRequired).toBe(false);
    });
});
