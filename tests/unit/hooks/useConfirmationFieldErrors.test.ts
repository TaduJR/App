import {act, renderHook} from '@testing-library/react-native';

import type {ConfirmationFieldErrors, SiblingFieldErrors} from '@components/MoneyRequestConfirmationList/getConfirmationFieldErrors';
import {NO_FIELD_ERRORS} from '@components/MoneyRequestConfirmationList/getConfirmationFieldErrors';
import useConfirmationFieldErrors from '@components/MoneyRequestConfirmationList/hooks/useConfirmationFieldErrors';

jest.mock('@hooks/useLocalize', () => () => ({translate: (key: string) => key}));

type Props = {
    fieldErrors: ConfirmationFieldErrors;
    siblingFieldErrors?: SiblingFieldErrors;
    onSwitchToTransaction?: (transactionID: string) => void;
    formErrorMessage?: string;
    routeError?: string;
};

const MISSING_AMOUNT: ConfirmationFieldErrors = {amount: 'common.error.fieldRequired'};
const PARTIALLY_FILLED_SIBLING: SiblingFieldErrors = {transactionID: 'txn2', fieldErrors: MISSING_AMOUNT};
const INVALID_SIBLING: SiblingFieldErrors = {transactionID: 'txn2', fieldErrors: {amount: 'common.error.invalidAmount'}};

function renderFieldErrors(initialProps: Props) {
    return renderHook(
        ({fieldErrors, siblingFieldErrors, onSwitchToTransaction, formErrorMessage, routeError}: Props) =>
            useConfirmationFieldErrors({fieldErrors, siblingFieldErrors, onSwitchToTransaction, formErrorMessage, routeError}),
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
        expect(result.current.footerErrorMessage).toBeUndefined();
    });

    it.each([
        ['a missing value', MISSING_AMOUNT, undefined, 'iou.error.enterRequiredFields'],
        ['only invalid values', {amount: 'common.error.invalidAmount'}, undefined, 'common.error.fixErrorsBeforeContinuing'],
        ['a missing value together with an invalid one', {date: 'common.error.fieldRequired', merchant: 'iou.error.invalidMerchant'}, undefined, 'iou.error.enterRequiredFields'],
        ['only an invalid value on another receipt', NO_FIELD_ERRORS, INVALID_SIBLING, 'common.error.fixErrorsBeforeContinuing'],
    ] as const)('picks the footer summary for %s once a confirm is blocked', (_case, fieldErrors, siblingFieldErrors, expectedMessage) => {
        // Given a confirmation whose receipt on screen, or another receipt of the multi-scan, holds these field errors
        const {result} = renderFieldErrors({fieldErrors, siblingFieldErrors});

        // When the confirm is blocked by them
        act(() => result.current.revealFieldErrors());

        // Then the summary asks for the required fields whenever a value is missing, and otherwise asks to fix the errors, since nothing is missing for "required fields" to describe
        expect(result.current.footerErrorMessage).toBe(expectedMessage);
    });

    it('keeps the errors shown while any field is still missing, and hides them once all are filled in', () => {
        // Given a blocked confirm with both the amount and the merchant missing
        const {result, rerender} = renderFieldErrors({fieldErrors: {amount: 'common.error.fieldRequired', merchant: 'common.error.fieldRequired'}});
        act(() => result.current.revealFieldErrors());

        // When only the amount is filled in
        rerender({fieldErrors: {merchant: 'common.error.fieldRequired'}});

        // Then the merchant and the summary still show
        expect(result.current.visibleFieldErrors).toEqual({merchant: 'common.error.fieldRequired'});
        expect(result.current.footerErrorMessage).toBe('iou.error.enterRequiredFields');

        // When the merchant is filled in as well
        rerender({fieldErrors: NO_FIELD_ERRORS});

        // Then the summary goes away
        expect(result.current.footerErrorMessage).toBeUndefined();

        // When the user empties a field again afterwards
        rerender({fieldErrors: MISSING_AMOUNT});

        // Then it is only flagged on the next blocked confirm, as before the first one
        expect(result.current.visibleFieldErrors).toBe(NO_FIELD_ERRORS);
    });

    it('puts the summary over a form error raised elsewhere, and leaves that error to block once the fields are filled in', () => {
        // Given a distance expense whose rate error is in the footer, and whose date is missing
        const rateError = 'iou.error.invalidRate';
        const {result, rerender} = renderFieldErrors({fieldErrors: {date: 'common.error.fieldRequired'}, formErrorMessage: rateError});

        // When a confirm is blocked by the missing date
        act(() => result.current.revealFieldErrors());

        // Then the summary takes the footer, since the date may be scrolled out of view
        expect(result.current.footerErrorMessage).toBe('iou.error.enterRequiredFields');

        // When the date is filled in while the rate is still out of policy
        rerender({fieldErrors: NO_FIELD_ERRORS, formErrorMessage: rateError});

        // Then the rate error is back in the footer, as it was never cleared and still blocks confirming
        expect(result.current.footerErrorMessage).toBe(rateError);
    });

    it('keeps a route error in the footer over the summary and any other form error', () => {
        // Given a distance expense whose route failed to load, with its date missing and another form error set
        const routeError = 'Could not load the route';
        const {result} = renderFieldErrors({fieldErrors: {date: 'common.error.fieldRequired'}, formErrorMessage: 'Please select a valid distance rate', routeError});

        // When nothing has been confirmed yet
        // Then the route error shows over the form error
        expect(result.current.footerErrorMessage).toBe(routeError);

        // When the field errors are revealed
        act(() => result.current.revealFieldErrors());

        // Then the route error stays over the summary, since the expense can't be confirmed until the route loads
        expect(result.current.footerErrorMessage).toBe(routeError);
    });

    it('keeps an invalid value on the receipt on screen in view before moving to a partially filled sibling', () => {
        // Given a multi-scan whose receipt on screen has a typed merchant that isn't allowed, while a sibling receipt is partially filled
        const onSwitchToTransaction = jest.fn();
        const {result, rerender} = renderFieldErrors({fieldErrors: {merchant: 'iou.error.invalidMerchant'}, siblingFieldErrors: PARTIALLY_FILLED_SIBLING, onSwitchToTransaction});

        // When the confirm is blocked
        act(() => result.current.revealFieldErrors());

        // Then the receipt on screen stays, so its error is seen, and the summary asks to fix the error it shows
        expect(onSwitchToTransaction).not.toHaveBeenCalled();
        expect(result.current.footerErrorMessage).toBe('common.error.fixErrorsBeforeContinuing');

        // When the user fixes the merchant and confirms again
        rerender({fieldErrors: NO_FIELD_ERRORS, siblingFieldErrors: PARTIALLY_FILLED_SIBLING, onSwitchToTransaction});
        act(() => result.current.revealFieldErrors());

        // Then the partially filled sibling is brought on screen and the summary asks for its required fields
        expect(onSwitchToTransaction).toHaveBeenCalledWith('txn2');
        expect(result.current.footerErrorMessage).toBe('iou.error.enterRequiredFields');

        // When the sibling is filled in too
        rerender({fieldErrors: NO_FIELD_ERRORS, siblingFieldErrors: undefined, onSwitchToTransaction});

        // Then the summary goes away
        expect(result.current.footerErrorMessage).toBeUndefined();
    });
});
