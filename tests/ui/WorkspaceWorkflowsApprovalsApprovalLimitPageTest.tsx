import {act, fireEvent, render, screen} from '@testing-library/react-native';

import ComposeProviders from '@components/ComposeProviders';
import HTMLEngineProvider from '@components/HTMLEngineProvider';
import {LocaleContextProvider} from '@components/LocaleContextProvider';
import OnyxListItemProvider from '@components/OnyxListItemProvider';

import Navigation from '@libs/Navigation/Navigation';
import {INITIAL_APPROVAL_WORKFLOW} from '@libs/WorkflowUtils';

import WorkspaceWorkflowsApprovalsApprovalLimitPage from '@pages/workspace/workflows/approvals/WorkspaceWorkflowsApprovalsApprovalLimitPage';

import {setApprovalWorkflow} from '@userActions/Workflow';

import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import SCREENS from '@src/SCREENS';
import type {Policy} from '@src/types/onyx';
import type {PersonalDetailsList} from '@src/types/onyx/PersonalDetails';

import type {PropsWithChildren} from 'react';

import {NavigationContainer} from '@react-navigation/native';
import {createStackNavigator} from '@react-navigation/stack';
import React from 'react';
import Onyx from 'react-native-onyx';

import createMock from '../utils/createMock';
import {buildPersonalDetails, translateLocal} from '../utils/TestHelper';
import waitForBatchedUpdatesWithAct from '../utils/waitForBatchedUpdatesWithAct';

const POLICY_ID = 'workflow-approval-limit-test-policy';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_ACCOUNT_ID = 1;
const BOB_EMAIL = 'bob@example.com';
const BOB_ACCOUNT_ID = 2;
const ERIN_EMAIL = 'erin@example.com';
const ERIN_ACCOUNT_ID = 3;
const DAVE_EMAIL = 'dave@example.com';
const DAVE_ACCOUNT_ID = 4;

jest.mock('@pages/workspace/AccessOrNotFoundWrapper', () => jest.fn(({children}: PropsWithChildren) => children));

jest.mock('@react-navigation/native', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const actualNav = jest.requireActual('@react-navigation/native');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return {
        ...actualNav,
        useIsFocused: () => true,
        usePreventRemove: jest.fn(),
    };
});

jest.mock('@libs/Navigation/Navigation', () => ({
    goBack: jest.fn(),
    navigate: jest.fn(),
    getActiveRouteWithoutParams: jest.fn(() => ''),
    isNavigationReady: jest.fn(() => Promise.resolve()),
}));

function buildPolicy(): Policy {
    return createMock<Policy>({
        id: POLICY_ID,
        name: 'Test Workspace',
        type: CONST.POLICY.TYPE.CORPORATE,
        role: CONST.POLICY.ROLE.ADMIN,
        owner: ADMIN_EMAIL,
        approver: ADMIN_EMAIL,
        approvalMode: CONST.POLICY.APPROVAL_MODE.ADVANCED,
        areWorkflowsEnabled: true,
        outputCurrency: CONST.CURRENCY.USD,
        employeeList: {
            [ADMIN_EMAIL]: {email: ADMIN_EMAIL, role: CONST.POLICY.ROLE.ADMIN, submitsTo: ADMIN_EMAIL},
            [BOB_EMAIL]: {email: BOB_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL},
            [ERIN_EMAIL]: {email: ERIN_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL},
            [DAVE_EMAIL]: {email: DAVE_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL},
        },
    });
}

function buildPersonalDetailsList(): PersonalDetailsList {
    return {
        [ADMIN_ACCOUNT_ID]: buildPersonalDetails(ADMIN_EMAIL, ADMIN_ACCOUNT_ID, 'admin'),
        [BOB_ACCOUNT_ID]: buildPersonalDetails(BOB_EMAIL, BOB_ACCOUNT_ID, 'bob'),
        [ERIN_ACCOUNT_ID]: buildPersonalDetails(ERIN_EMAIL, ERIN_ACCOUNT_ID, 'erin'),
        [DAVE_ACCOUNT_ID]: buildPersonalDetails(DAVE_EMAIL, DAVE_ACCOUNT_ID, 'dave'),
    };
}

const Stack = createStackNavigator();

async function renderPage(approverIndex: number) {
    const result = render(
        <NavigationContainer>
            <Stack.Navigator>
                <Stack.Screen name={SCREENS.WORKSPACE.WORKFLOWS_APPROVALS_APPROVAL_LIMIT}>
                    {() => (
                        <ComposeProviders components={[OnyxListItemProvider, LocaleContextProvider, HTMLEngineProvider]}>
                            <WorkspaceWorkflowsApprovalsApprovalLimitPage
                                // @ts-expect-error - the page only reads route.params
                                route={{name: SCREENS.WORKSPACE.WORKFLOWS_APPROVALS_APPROVAL_LIMIT, params: {policyID: POLICY_ID, approverIndex}}}
                            />
                        </ComposeProviders>
                    )}
                </Stack.Screen>
            </Stack.Navigator>
        </NavigationContainer>,
    );
    await waitForBatchedUpdatesWithAct();
    return result;
}

describe('WorkspaceWorkflowsApprovalsApprovalLimitPage', () => {
    beforeAll(() => {
        Onyx.init({keys: ONYXKEYS});
    });

    beforeEach(async () => {
        jest.mocked(Navigation.goBack).mockClear();
        await act(async () => {
            await Onyx.clear();
            await Onyx.set(ONYXKEYS.HAS_LOADED_APP, true);
            await Onyx.set(ONYXKEYS.IS_LOADING_REPORT_DATA, false);
            await Onyx.set(`${ONYXKEYS.COLLECTION.POLICY}${POLICY_ID}`, buildPolicy());
            await Onyx.set(ONYXKEYS.PERSONAL_DETAILS_LIST, buildPersonalDetailsList());
            await Onyx.merge(ONYXKEYS.SESSION, {email: ADMIN_EMAIL, accountID: ADMIN_ACCOUNT_ID});

            // A saved workflow Bob > Erin, where Bob's reports over the limit go to Erin
            setApprovalWorkflow({
                ...INITIAL_APPROVAL_WORKFLOW,
                action: CONST.APPROVAL_WORKFLOW.ACTION.EDIT,
                members: [{email: DAVE_EMAIL, displayName: DAVE_EMAIL}],
                approvers: [
                    {email: BOB_EMAIL, displayName: BOB_EMAIL, approvalLimit: 5000, overLimitForwardsTo: ERIN_EMAIL},
                    {email: ERIN_EMAIL, displayName: ERIN_EMAIL},
                ],
            });
        });
        await waitForBatchedUpdatesWithAct();
    });

    it('explains why the additional approver blocks the save with the multiple approvers beta', async () => {
        // Given the workflow is saved as approval workflow rules
        await act(async () => {
            await Onyx.set(ONYXKEYS.BETAS, [CONST.BETAS.MULTIPLE_APPROVERS]);
        });
        await waitForBatchedUpdatesWithAct();

        // When the admin opens Bob's step from the editor, which flags it
        await renderPage(0);

        // Then the additional approver shows the same error, so the page where the admin fixes it says what is wrong
        expect(screen.getByText(translateLocal('workflowsPage.overLimitApproverInWorkflow'))).toBeOnTheScreen();
    });

    it('keeps the admin on the page when saving an additional approver who blocks the workflow', async () => {
        // Given the workflow is saved as approval workflow rules, and Bob's additional approver already approves in it
        await act(async () => {
            await Onyx.set(ONYXKEYS.BETAS, [CONST.BETAS.MULTIPLE_APPROVERS]);
        });
        await waitForBatchedUpdatesWithAct();
        await renderPage(0);

        // When the admin taps Save without picking a different additional approver
        fireEvent.press(screen.getByText(translateLocal('common.save')));
        await waitForBatchedUpdatesWithAct();

        // Then they stay here, where the error tells them what to change, rather than going back to an editor that can't save
        expect(Navigation.goBack).not.toHaveBeenCalled();
        expect(screen.getByText(translateLocal('workflowsPage.overLimitApproverInWorkflow'))).toBeOnTheScreen();
    });

    it("leaves a repeated approver's step to the circular workflow error", async () => {
        // Given the circular workflow Bob > Erin > Bob, where the repeated Bob's reports over the limit go to Erin, with the beta
        await act(async () => {
            await Onyx.set(ONYXKEYS.BETAS, [CONST.BETAS.MULTIPLE_APPROVERS]);
            setApprovalWorkflow({
                ...INITIAL_APPROVAL_WORKFLOW,
                action: CONST.APPROVAL_WORKFLOW.ACTION.EDIT,
                members: [{email: DAVE_EMAIL, displayName: DAVE_EMAIL}],
                approvers: [
                    {email: BOB_EMAIL, displayName: BOB_EMAIL},
                    {email: ERIN_EMAIL, displayName: ERIN_EMAIL},
                    {email: BOB_EMAIL, displayName: BOB_EMAIL, isCircularReference: true, approvalLimit: 5000, overLimitForwardsTo: ERIN_EMAIL},
                ],
            });
        });
        await waitForBatchedUpdatesWithAct();
        await renderPage(2);

        // When the admin taps Save on the repeated step
        fireEvent.press(screen.getByText(translateLocal('common.save')));
        await waitForBatchedUpdatesWithAct();

        // Then the page shows no over-limit error and goes back, since the editor only shows the circular workflow error on that row
        expect(screen.queryByText(translateLocal('workflowsPage.overLimitApproverInWorkflow'))).not.toBeOnTheScreen();
        expect(Navigation.goBack).toHaveBeenCalled();
    });

    describe('additional approver who left the workspace', () => {
        beforeEach(async () => {
            // Bob's additional approver for reports over the limit is no longer on the workspace
            await act(async () => {
                setApprovalWorkflow({
                    ...INITIAL_APPROVAL_WORKFLOW,
                    action: CONST.APPROVAL_WORKFLOW.ACTION.EDIT,
                    members: [{email: DAVE_EMAIL, displayName: DAVE_EMAIL}],
                    approvers: [
                        {email: BOB_EMAIL, displayName: BOB_EMAIL, approvalLimit: 5000, overLimitForwardsTo: 'removed@example.com', isOverLimitForwardsToNotWorkspaceMember: true},
                        {email: ERIN_EMAIL, displayName: ERIN_EMAIL},
                    ],
                });
            });
            await waitForBatchedUpdatesWithAct();
        });

        it('shows the editor error with the multiple approvers beta', async () => {
            // Given the workflow is saved as approval workflow rules
            await act(async () => {
                await Onyx.set(ONYXKEYS.BETAS, [CONST.BETAS.MULTIPLE_APPROVERS]);
            });
            await waitForBatchedUpdatesWithAct();

            // When the admin opens Bob's step from the editor, which flags it
            await renderPage(0);

            // Then the additional approver shows the same error as the editor, so the admin knows to pick a new one here
            expect(screen.getByText(translateLocal('workflowsPage.overLimitApproverNotWorkspaceMember'))).toBeOnTheScreen();
        });

        it('still saves the step without the multiple approvers beta', async () => {
            // Given the workflow is saved through the employeeList, without the beta
            await renderPage(0);

            // When the admin taps Save
            fireEvent.press(screen.getByText(translateLocal('common.save')));
            await waitForBatchedUpdatesWithAct();

            // Then the page works as it did before the beta-only rule, and the editor flags the step instead
            expect(screen.queryByText(translateLocal('workflowsPage.overLimitApproverNotWorkspaceMember'))).not.toBeOnTheScreen();
            expect(Navigation.goBack).toHaveBeenCalled();
        });
    });

    it('shows no error for the same additional approver without the multiple approvers beta', async () => {
        // Given the workflow is saved through the employeeList, without the beta
        // When the admin opens Bob's step
        await renderPage(0);

        // Then the additional approver shows no error, since the employeeList routing used without the beta stays as it was
        expect(screen.getByText(translateLocal('workflowsApprovalLimitPage.additionalApproverLabel'))).toBeOnTheScreen();
        expect(screen.queryByText(translateLocal('workflowsPage.overLimitApproverInWorkflow'))).not.toBeOnTheScreen();
    });
});
