import {act, renderHook} from '@testing-library/react-native';

import buildConfirmAction from '@components/MoneyRequestConfirmationList/confirmAction';
import useConfirmationFieldErrors from '@components/MoneyRequestConfirmationList/hooks/useConfirmationFieldErrors';
import useConfirmationValidation from '@components/MoneyRequestConfirmationList/hooks/useConfirmationValidation';
import useFormErrorManagement from '@components/MoneyRequestConfirmationList/hooks/useFormErrorManagement';

import {getMerchant} from '@libs/TransactionUtils';

import CONST from '@src/CONST';
import type * as OnyxTypes from '@src/types/onyx';
import type {Participant} from '@src/types/onyx/IOU';
import type {CurrentUserPersonalDetails} from '@src/types/onyx/PersonalDetails';

import type * as ReactNavigationModule from '@react-navigation/native';

jest.mock('@hooks/useLocalize', () => () => ({translate: (key: string) => key}));
jest.mock('@hooks/useCurrencyList', () => ({useCurrencyListActions: () => ({getCurrencyDecimals: () => 2})}));
jest.mock('@libs/Navigation/Navigation', () => ({navigate: jest.fn(), getActiveRoute: () => '/'}));
jest.mock('@userActions/Policy/Policy', () => ({hasInvoicingDetails: jest.fn(() => true)}));
jest.mock('@react-navigation/native', () => {
    const actual = jest.requireActual<typeof ReactNavigationModule>('@react-navigation/native');
    return {...actual, useIsFocused: () => true};
});

const WORKSPACE_PARTICIPANT = {accountID: 0, isPolicyExpenseChat: true, policyID: 'policy1'} as Participant;
const CURRENT_USER = {accountID: 1} as CurrentUserPersonalDetails;
const mockOnConfirm = jest.fn();

// A manual expense to a workspace, as the draft starts: no amount entered and the "Expense" placeholder as its merchant
const blankDraft: OnyxTypes.Transaction = {
    transactionID: 'txn1',
    reportID: 'report1',
    amount: 0,
    currency: 'USD',
    merchant: CONST.TRANSACTION.DEFAULT_MERCHANT,
    created: '2026-11-05',
    comment: {},
    iouRequestType: CONST.IOU.REQUEST_TYPE.MANUAL,
    isAmountSet: false,
    isMerchantSet: false,
    participants: [WORKSPACE_PARTICIPANT],
};

/** Wires the form error, validation, field error and confirm pieces together the way `useConfirmationListData` does. */
function useManualWorkspaceConfirmation(transaction: OnyxTypes.Transaction) {
    const iouMerchant = getMerchant(transaction);
    const {formError, setFormError, shouldDisplayFieldError, isMerchantEmpty, isMerchantFieldValid, isMerchantRequired, errorMessage} = useFormErrorManagement({
        transaction,
        transactionReport: undefined,
        iouMerchant,
        iouCategory: '',
        iouAttendees: [],
        policy: undefined,
        policyTags: undefined,
        policyCategories: undefined,
        currentUserPersonalDetails: CURRENT_USER,
        isEditingSplitBill: false,
        isPolicyExpenseChat: true,
        isScanRequest: false,
        shouldShowMerchant: true,
        hasSmartScanFailed: false,
        didConfirmSplit: false,
        routeError: undefined,
        isTypeSplit: false,
        shouldShowReadOnlySplits: true,
        isDistanceRequest: false,
    });
    const {validate, fieldErrors} = useConfirmationValidation({
        transaction,
        transactionReport: undefined,
        transactionID: transaction.transactionID,
        iouType: CONST.IOU.TYPE.SUBMIT,
        iouAmount: transaction.amount,
        iouMerchant,
        iouCategory: '',
        iouCurrencyCode: 'USD',
        iouAttendees: [],
        policy: undefined,
        policyTags: undefined,
        policyTagLists: [],
        policyCategories: undefined,
        selectedParticipants: [WORKSPACE_PARTICIPANT],
        currentUserPersonalDetails: CURRENT_USER,
        isEditingSplitBill: false,
        isMerchantRequired,
        isMerchantFieldValid,
        isMerchantEmpty,
        shouldDisplayFieldError,
        shouldShowTax: false,
        isDistanceRequest: false,
        isDistanceRequestWithPendingRoute: false,
        isPerDiemRequest: false,
        isMovingTransactionFromTrackExpense: false,
        isTimeRequest: false,
        routeError: undefined,
        canEnterScanFieldsManually: false,
        isPolicyExpenseChat: true,
        isReadOnly: false,
        shouldShowDate: true,
        isTaxAmountEmpty: false,
    });
    const {visibleFieldErrors, footerErrorMessage, revealFieldErrors} = useConfirmationFieldErrors({
        fieldErrors,
        partiallyManuallyFilledScanID: undefined,
        onSwitchToTransaction: undefined,
        formErrorMessage: errorMessage,
        hasRouteError: false,
    });
    const confirm = buildConfirmAction({
        iouType: CONST.IOU.TYPE.SUBMIT,
        policy: undefined,
        transactionID: transaction.transactionID,
        routeError: undefined,
        formError,
        isDelegateAccessRestricted: false,
        validate,
        setFormError,
        revealFieldErrors,
        setDidConfirmSplit: jest.fn(),
        showDelegateNoAccessModal: jest.fn(),
        onConfirm: mockOnConfirm,
    });

    return {confirm, validate, visibleFieldErrors, footerErrorMessage};
}

describe('required fields on a manual workspace expense', () => {
    beforeEach(() => {
        mockOnConfirm.mockClear();
    });

    it('keeps the blank merchant flagged and the summary shown after only the amount is entered', () => {
        // Given a manual workspace expense with neither an amount nor a merchant
        const {result, rerender} = renderHook((transaction: OnyxTypes.Transaction) => useManualWorkspaceConfirmation(transaction), {initialProps: blankDraft});

        // When the user presses Create
        act(() => result.current.confirm());

        // Then both fields read as required and the summary sits above the button, as either may be scrolled out of view
        expect(result.current.visibleFieldErrors).toEqual({amount: 'common.error.fieldRequired', merchant: 'common.error.fieldRequired'});
        expect(result.current.footerErrorMessage).toBe('iou.error.enterRequiredFields');

        // When the user enters only the amount
        rerender({...blankDraft, amount: 2500, isAmountSet: true});

        // Then the merchant is still flagged and the summary stays, since a required field is still missing
        expect(result.current.visibleFieldErrors).toEqual({merchant: 'common.error.fieldRequired'});
        expect(result.current.footerErrorMessage).toBe('iou.error.enterRequiredFields');

        // When the user presses Create again
        act(() => result.current.confirm());

        // Then the blank merchant still reads as required rather than invalid, so the summary still explains the block
        expect(result.current.validate()).toEqual({errorKey: 'common.error.fieldRequired', isFieldError: true});
        expect(result.current.footerErrorMessage).toBe('iou.error.enterRequiredFields');
        expect(mockOnConfirm).not.toHaveBeenCalled();
    });

    it('clears the errors and confirms once every required field is filled in', () => {
        // Given a blocked confirm on a manual workspace expense with neither an amount nor a merchant
        const {result, rerender} = renderHook((transaction: OnyxTypes.Transaction) => useManualWorkspaceConfirmation(transaction), {initialProps: blankDraft});
        act(() => result.current.confirm());

        // When the user enters both the amount and the merchant
        rerender({...blankDraft, amount: 2500, isAmountSet: true, merchant: 'Office Depot', isMerchantSet: true});

        // Then nothing is flagged any more
        expect(result.current.visibleFieldErrors).toEqual({});
        expect(result.current.footerErrorMessage).toBeUndefined();

        // When the user presses Create
        act(() => result.current.confirm());

        // Then the expense is confirmed
        expect(mockOnConfirm).toHaveBeenCalledTimes(1);
    });
});
