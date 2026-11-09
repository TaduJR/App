import {act, renderHook} from '@testing-library/react-native';

import type {ConfirmationFieldErrors} from '@components/MoneyRequestConfirmationList/getConfirmationFieldErrors';
import {NO_FIELD_ERRORS} from '@components/MoneyRequestConfirmationList/getConfirmationFieldErrors';
import useConfirmationFieldErrors from '@components/MoneyRequestConfirmationList/hooks/useConfirmationFieldErrors';

jest.mock('@hooks/useLocalize', () => () => ({translate: (key: string) => key}));

type Props = {fieldErrors: ConfirmationFieldErrors; partiallyManuallyFilledScanID?: string; onSwitchToTransaction?: (transactionID: string) => void};

const MISSING_AMOUNT: ConfirmationFieldErrors = {amount: 'common.error.fieldRequired'};

function renderFieldErrors(initialProps: Props) {
    return renderHook(
        ({fieldErrors, partiallyManuallyFilledScanID, onSwitchToTransaction}: Props) => useConfirmationFieldErrors({fieldErrors, partiallyManuallyFilledScanID, onSwitchToTransaction}),
        {initialProps},
    );
}

describe('useConfirmationFieldErrors', () => {
    it('keeps the field errors hidden until a confirm is blocked by them', () => {
        // Given a confirmation whose amount is missing, before the user pressed the confirm button
        // When it renders
        const {result} = renderFieldErrors({fieldErrors: MISSING_AMOUNT});

        // Then neither the field nor the footer flags anything yet
        expect(result.current.visibleFieldErrors).toBe(NO_FIELD_ERRORS);
        expect(result.current.fieldErrorSummary).toBeUndefined();
    });

    it('shows the field errors and the footer summary once a confirm is blocked', () => {
        // Given a confirmation whose amount is missing
        const {result} = renderFieldErrors({fieldErrors: MISSING_AMOUNT});

        // When the confirm is blocked by it
        act(() => result.current.revealFieldErrors());

        // Then the amount shows its error, and the summary above the button explains the block even if the amount is scrolled away
        expect(result.current.visibleFieldErrors).toEqual(MISSING_AMOUNT);
        expect(result.current.fieldErrorSummary).toBe('iou.error.enterRequiredFields');
    });

    it('does not show the required fields summary when every field error is an invalid value', () => {
        // Given a confirmation whose only field error is an invalid amount
        const {result} = renderFieldErrors({fieldErrors: {amount: 'common.error.invalidAmount'}});

        // When the confirm is blocked by it
        act(() => result.current.revealFieldErrors());

        // Then the field shows it, but the summary that asks for required fields stays out of the footer
        expect(result.current.visibleFieldErrors).toEqual({amount: 'common.error.invalidAmount'});
        expect(result.current.fieldErrorSummary).toBeUndefined();
    });

    it('keeps the errors shown while any field is still missing, and hides them once all are filled in', () => {
        // Given a blocked confirm with both the amount and the merchant missing
        const {result, rerender} = renderFieldErrors({fieldErrors: {amount: 'common.error.fieldRequired', merchant: 'common.error.fieldRequired'}});
        act(() => result.current.revealFieldErrors());

        // When only the amount is filled in
        rerender({fieldErrors: {merchant: 'common.error.fieldRequired'}});

        // Then the merchant and the summary still show
        expect(result.current.visibleFieldErrors).toEqual({merchant: 'common.error.fieldRequired'});
        expect(result.current.fieldErrorSummary).toBe('iou.error.enterRequiredFields');

        // When the merchant is filled in as well
        rerender({fieldErrors: NO_FIELD_ERRORS});

        // Then nothing is flagged
        expect(result.current.visibleFieldErrors).toBe(NO_FIELD_ERRORS);
        expect(result.current.fieldErrorSummary).toBeUndefined();

        // When the user empties a field again afterwards
        rerender({fieldErrors: MISSING_AMOUNT});

        // Then it is only flagged on the next blocked confirm, as before the first one
        expect(result.current.visibleFieldErrors).toBe(NO_FIELD_ERRORS);
        expect(result.current.fieldErrorSummary).toBeUndefined();
    });

    it('brings the partially filled sibling receipt on screen when the receipt on screen is complete', () => {
        // Given a multi-scan whose receipt on screen is complete while a sibling receipt is partially filled
        const onSwitchToTransaction = jest.fn();
        const {result} = renderFieldErrors({fieldErrors: NO_FIELD_ERRORS, partiallyManuallyFilledScanID: 'txn2', onSwitchToTransaction});

        // When the confirm is blocked by the sibling
        act(() => result.current.revealFieldErrors());

        // Then the sibling is brought on screen, so its blank fields show their errors instead of Create looking like it did nothing
        expect(onSwitchToTransaction).toHaveBeenCalledWith('txn2');
    });

    it('stays on the receipt on screen when it has field errors of its own', () => {
        // Given a multi-scan whose receipt on screen is missing its amount, while a sibling receipt is also partially filled
        const onSwitchToTransaction = jest.fn();
        const {result} = renderFieldErrors({fieldErrors: MISSING_AMOUNT, partiallyManuallyFilledScanID: 'txn2', onSwitchToTransaction});

        // When the confirm is blocked
        act(() => result.current.revealFieldErrors());

        // Then the user keeps the receipt they are on, which now shows its own errors
        expect(onSwitchToTransaction).not.toHaveBeenCalled();
        expect(result.current.visibleFieldErrors).toEqual(MISSING_AMOUNT);
    });

    it('keeps the summary while a sibling receipt of a multi-scan is still partially filled', () => {
        // Given a blocked confirm on a multi-scan whose partially filled receipt is not the one on screen
        const {result, rerender} = renderFieldErrors({fieldErrors: NO_FIELD_ERRORS, partiallyManuallyFilledScanID: 'txn2'});
        act(() => result.current.revealFieldErrors());

        // When the complete receipt is still the one on screen
        // Then the summary still explains why the confirm is blocked
        expect(result.current.fieldErrorSummary).toBe('iou.error.enterRequiredFields');

        // When no receipt is partially filled any more
        rerender({fieldErrors: NO_FIELD_ERRORS, partiallyManuallyFilledScanID: undefined});

        // Then the summary goes away
        expect(result.current.fieldErrorSummary).toBeUndefined();
    });
});
