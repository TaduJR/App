/**
 * Owns when the amount, date and merchant errors of the money request confirmation become visible, and the summary
 * shown above its confirm button while one of them blocks confirming.
 */
import type {ConfirmationFieldErrors} from '@components/MoneyRequestConfirmationList/getConfirmationFieldErrors';
import {NO_FIELD_ERRORS} from '@components/MoneyRequestConfirmationList/getConfirmationFieldErrors';

import useLocalize from '@hooks/useLocalize';

import {getFixTheErrorsMessage} from '@libs/ValidationUtils';

import {useState} from 'react';

type UseConfirmationFieldErrorsParams = {
    /** The errors the amount, date and merchant fields would show now, from `useConfirmationValidation` */
    fieldErrors: ConfirmationFieldErrors;

    /** ID of a partially filled Scan among the transactions being confirmed. Can name a receipt other than this one. */
    partiallyManuallyFilledScanID: string | undefined;

    /** Brings another receipt of a multi-scan on screen */
    onSwitchToTransaction: ((transactionID: string) => void) | undefined;

    /** The footer message built from the form error by `useFormErrorManagement`, which already puts a route error first */
    formErrorMessage: string | undefined;

    /** Whether the route has an error, which keeps that error in the footer over the field errors summary */
    hasRouteError: boolean;
};

type UseConfirmationFieldErrorsResult = {
    /** The field errors to render. Empty until a confirm is blocked by one of them. */
    visibleFieldErrors: ConfirmationFieldErrors;

    /** The message above the confirm button: a route error, then the field errors summary while it applies, then the form error */
    footerErrorMessage: string | undefined;

    /** Shows the field errors after a confirm they blocked, bringing the receipt they belong to on screen */
    revealFieldErrors: () => void;
};

/** The errors themselves are derived from the transaction, so only the fact that a confirm was blocked is kept as state. */
function useConfirmationFieldErrors({
    fieldErrors,
    partiallyManuallyFilledScanID,
    onSwitchToTransaction,
    formErrorMessage,
    hasRouteError,
}: UseConfirmationFieldErrorsParams): UseConfirmationFieldErrorsResult {
    const {translate} = useLocalize();
    const [shouldShowFieldErrors, setShouldShowFieldErrors] = useState(false);

    const hasFieldErrors = Object.keys(fieldErrors).length > 0 || !!partiallyManuallyFilledScanID;

    // Hide the errors again once everything is filled in, so a field the user empties afterwards is only flagged on
    // the next confirm, the same way it was before the first one. A partially filled sibling receipt keeps them shown.
    if (shouldShowFieldErrors && !hasFieldErrors) {
        setShouldShowFieldErrors(false);
    }

    const isRequiredFieldMissing = Object.values(fieldErrors).includes('common.error.fieldRequired') || !!partiallyManuallyFilledScanID;

    const revealFieldErrors = () => {
        setShouldShowFieldErrors(true);

        // When the receipt on screen is complete, the blocking one is a partially filled sibling, so bring it into view.
        if (Object.keys(fieldErrors).length === 0 && partiallyManuallyFilledScanID) {
            onSwitchToTransaction?.(partiallyManuallyFilledScanID);
        }
    };

    // A missing value asks for the required fields, and a field holding only an invalid value gets the line every form shows above its submit button.
    let fieldErrorSummary: string | undefined;
    if (shouldShowFieldErrors && hasFieldErrors) {
        fieldErrorSummary = isRequiredFieldMissing ? translate('iou.error.enterRequiredFields') : getFixTheErrorsMessage(translate);
    }

    return {
        visibleFieldErrors: shouldShowFieldErrors ? fieldErrors : NO_FIELD_ERRORS,
        // The summary only covers a form error raised elsewhere, like the distance rate one, so that error stays set and still blocks confirming once the fields are filled in.
        footerErrorMessage: fieldErrorSummary && !hasRouteError ? fieldErrorSummary : formErrorMessage,
        revealFieldErrors,
    };
}

export default useConfirmationFieldErrors;
