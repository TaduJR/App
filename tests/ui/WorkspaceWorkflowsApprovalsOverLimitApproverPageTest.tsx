import {act, render} from '@testing-library/react-native';

import type {SelectionListApprover} from '@components/ApproverSelectionList';
import ApproverSelectionList from '@components/ApproverSelectionList';
import ComposeProviders from '@components/ComposeProviders';
import {LocaleContextProvider} from '@components/LocaleContextProvider';
import OnyxListItemProvider from '@components/OnyxListItemProvider';
import PersonalDetailsByLoginProvider from '@components/PersonalDetailsByLoginProvider';

import {INITIAL_APPROVAL_WORKFLOW} from '@libs/WorkflowUtils';

import WorkspaceWorkflowsApprovalsOverLimitApproverPage from '@pages/workspace/workflows/approvals/WorkspaceWorkflowsApprovalsOverLimitApproverPage';

import {setApprovalWorkflow} from '@userActions/Workflow';

import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import SCREENS from '@src/SCREENS';
import type {Policy} from '@src/types/onyx';
import type {PersonalDetailsList} from '@src/types/onyx/PersonalDetails';

import type {PropsWithChildren} from 'react';

import React from 'react';
import Onyx from 'react-native-onyx';

import createMock from '../utils/createMock';
import {buildPersonalDetails} from '../utils/TestHelper';
import waitForBatchedUpdatesWithAct from '../utils/waitForBatchedUpdatesWithAct';

const POLICY_ID = 'workflow-over-limit-approver-test-policy';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_ACCOUNT_ID = 1;
const BOB_EMAIL = 'bob@example.com';
const BOB_ACCOUNT_ID = 2;
const ERIN_EMAIL = 'erin@example.com';
const ERIN_ACCOUNT_ID = 3;
const DAVE_EMAIL = 'dave@example.com';
const DAVE_ACCOUNT_ID = 4;
const FRANK_EMAIL = 'frank@example.com';
const FRANK_ACCOUNT_ID = 5;

// The tests read the rows the page hands the list, so the list itself renders nothing.
jest.mock('@components/ApproverSelectionList', () => jest.fn(() => null));
jest.mock('@pages/workspace/AccessOrNotFoundWrapper', () => jest.fn(({children}: PropsWithChildren) => children));

jest.mock('@react-navigation/native', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const actualNav = jest.requireActual('@react-navigation/native');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return {
        ...actualNav,
        useNavigationState: () => [],
    };
});

jest.mock('@libs/Navigation/Navigation', () => ({
    goBack: jest.fn(),
    navigate: jest.fn(),
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
        employeeList: {
            [ADMIN_EMAIL]: {email: ADMIN_EMAIL, role: CONST.POLICY.ROLE.ADMIN, submitsTo: ADMIN_EMAIL},
            [BOB_EMAIL]: {email: BOB_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL},
            [ERIN_EMAIL]: {email: ERIN_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL},
            [DAVE_EMAIL]: {email: DAVE_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL},
            [FRANK_EMAIL]: {email: FRANK_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL},
        },
    });
}

function buildPersonalDetailsList(): PersonalDetailsList {
    return {
        [ADMIN_ACCOUNT_ID]: buildPersonalDetails(ADMIN_EMAIL, ADMIN_ACCOUNT_ID, 'admin'),
        [BOB_ACCOUNT_ID]: buildPersonalDetails(BOB_EMAIL, BOB_ACCOUNT_ID, 'bob'),
        [ERIN_ACCOUNT_ID]: buildPersonalDetails(ERIN_EMAIL, ERIN_ACCOUNT_ID, 'erin'),
        [DAVE_ACCOUNT_ID]: buildPersonalDetails(DAVE_EMAIL, DAVE_ACCOUNT_ID, 'dave'),
        [FRANK_ACCOUNT_ID]: buildPersonalDetails(FRANK_EMAIL, FRANK_ACCOUNT_ID, 'frank'),
    };
}

async function renderPage(approverIndex: number) {
    const result = render(
        <ComposeProviders components={[OnyxListItemProvider, PersonalDetailsByLoginProvider, LocaleContextProvider]}>
            <WorkspaceWorkflowsApprovalsOverLimitApproverPage
                // @ts-expect-error - the page only reads route.params
                route={{name: SCREENS.WORKSPACE.WORKFLOWS_APPROVALS_OVER_LIMIT_APPROVER, params: {policyID: POLICY_ID, approverIndex}}}
            />
        </ComposeProviders>,
    );
    await waitForBatchedUpdatesWithAct();
    return result;
}

function getRows(): SelectionListApprover[] {
    return jest.mocked(ApproverSelectionList).mock.lastCall?.[0].allApprovers ?? [];
}

function getRowLogins() {
    return getRows().map((row) => row.login);
}

describe('WorkspaceWorkflowsApprovalsOverLimitApproverPage', () => {
    beforeAll(() => {
        Onyx.init({keys: ONYXKEYS});
    });

    beforeEach(async () => {
        jest.mocked(ApproverSelectionList).mockClear();
        await act(async () => {
            await Onyx.clear();
            await Onyx.set(ONYXKEYS.HAS_LOADED_APP, true);
            await Onyx.set(ONYXKEYS.BETAS, [CONST.BETAS.MULTIPLE_APPROVERS]);
            await Onyx.set(ONYXKEYS.IS_LOADING_REPORT_DATA, false);
            await Onyx.set(`${ONYXKEYS.COLLECTION.POLICY}${POLICY_ID}`, buildPolicy());
            await Onyx.set(ONYXKEYS.PERSONAL_DETAILS_LIST, buildPersonalDetailsList());
            await Onyx.merge(ONYXKEYS.SESSION, {email: ADMIN_EMAIL, accountID: ADMIN_ACCOUNT_ID});
            setApprovalWorkflow({
                ...INITIAL_APPROVAL_WORKFLOW,
                action: CONST.APPROVAL_WORKFLOW.ACTION.EDIT,
                members: [{email: DAVE_EMAIL, displayName: DAVE_EMAIL}],
                approvers: [
                    {email: BOB_EMAIL, displayName: BOB_EMAIL, approvalLimit: 5000},
                    {email: ERIN_EMAIL, displayName: ERIN_EMAIL},
                ],
            });
        });
        await waitForBatchedUpdatesWithAct();
    });

    it('never offers an approver of the workflow as the additional approver for reports over the limit', async () => {
        // Given the rules-based workflow Bob > Erin, where Bob is setting a limit, and Erin already approves every report after him

        // When the admin picks who else approves Bob's reports over the limit
        await renderPage(0);

        // Then neither Bob nor Erin can be picked, since the limit would add no one, while everyone else can
        const logins = getRowLogins();
        expect(logins).not.toContain(BOB_EMAIL);
        expect(logins).not.toContain(ERIN_EMAIL);
        expect(logins).toEqual(expect.arrayContaining([ADMIN_EMAIL, DAVE_EMAIL, FRANK_EMAIL]));
    });

    it('keeps offering approvers of the workflow without the multiple approvers beta', async () => {
        // Given the workflow Bob > Erin on an account without the beta, which saves it through the employeeList
        await act(async () => {
            await Onyx.set(ONYXKEYS.BETAS, []);
        });
        await waitForBatchedUpdatesWithAct();

        // When the admin picks who else approves Bob's reports over the limit
        await renderPage(0);

        // Then Erin can still be picked, since the employeeList routing used without the beta stays as it was
        expect(getRowLogins()).toContain(ERIN_EMAIL);
    });

    it('keeps a saved additional approver who already approves in the workflow listed so the admin can clear them', async () => {
        // Given Bob > Erin > Frank saved while an approver of the workflow could still be picked, with Bob's reports over
        // the limit going to Erin
        await act(async () => {
            setApprovalWorkflow({
                ...INITIAL_APPROVAL_WORKFLOW,
                action: CONST.APPROVAL_WORKFLOW.ACTION.EDIT,
                members: [{email: DAVE_EMAIL, displayName: DAVE_EMAIL}],
                approvers: [
                    {email: BOB_EMAIL, displayName: BOB_EMAIL, approvalLimit: 5000, overLimitForwardsTo: ERIN_EMAIL},
                    {email: ERIN_EMAIL, displayName: ERIN_EMAIL},
                    {email: FRANK_EMAIL, displayName: FRANK_EMAIL},
                ],
            });
        });
        await waitForBatchedUpdatesWithAct();

        // When the admin opens who else approves Bob's reports over the limit
        await renderPage(0);

        // Then Erin is listed as the current pick, so the admin sees why the save is blocked and can tap her to clear it,
        // while Frank, who also approves in the workflow, still can't be picked
        expect(getRows().find((row) => row.login === ERIN_EMAIL)?.isSelected).toBe(true);
        expect(getRowLogins()).not.toContain(FRANK_EMAIL);
    });

    it('keeps a saved additional approver who is the approver themselves listed so the admin can clear them', async () => {
        // Given Bob > Erin saved with Bob's reports over the limit going back to Bob
        await act(async () => {
            setApprovalWorkflow({
                ...INITIAL_APPROVAL_WORKFLOW,
                action: CONST.APPROVAL_WORKFLOW.ACTION.EDIT,
                members: [{email: DAVE_EMAIL, displayName: DAVE_EMAIL}],
                approvers: [
                    {email: BOB_EMAIL, displayName: BOB_EMAIL, approvalLimit: 5000, overLimitForwardsTo: BOB_EMAIL},
                    {email: ERIN_EMAIL, displayName: ERIN_EMAIL},
                ],
            });
        });
        await waitForBatchedUpdatesWithAct();

        // When the admin opens who else approves Bob's reports over the limit
        await renderPage(0);

        // Then Bob is listed as the current pick, so the admin sees why the save is blocked and can tap him to clear it
        expect(getRows().find((row) => row.login === BOB_EMAIL)?.isSelected).toBe(true);
    });

    it('keeps a saved additional approver listed when preventing self-approval hides the other members', async () => {
        // Given a workspace that prevents self-approval, and Bob > Erin for Dave and Erin, with Bob's reports over the
        // limit going to Erin
        await act(async () => {
            await Onyx.merge(`${ONYXKEYS.COLLECTION.POLICY}${POLICY_ID}`, {preventSelfApproval: true});
            setApprovalWorkflow({
                ...INITIAL_APPROVAL_WORKFLOW,
                action: CONST.APPROVAL_WORKFLOW.ACTION.EDIT,
                members: [
                    {email: DAVE_EMAIL, displayName: DAVE_EMAIL},
                    {email: ERIN_EMAIL, displayName: ERIN_EMAIL},
                ],
                approvers: [
                    {email: BOB_EMAIL, displayName: BOB_EMAIL, approvalLimit: 5000, overLimitForwardsTo: ERIN_EMAIL},
                    {email: ERIN_EMAIL, displayName: ERIN_EMAIL},
                ],
            });
        });
        await waitForBatchedUpdatesWithAct();

        // When the admin opens who else approves Bob's reports over the limit
        await renderPage(0);

        // Then Erin is still listed as the current pick so the admin can clear her, while Dave stays hidden as a member
        expect(getRows().find((row) => row.login === ERIN_EMAIL)?.isSelected).toBe(true);
        expect(getRowLogins()).not.toContain(DAVE_EMAIL);
    });

    it('still leaves the approver themselves out without the multiple approvers beta', async () => {
        // Given Bob > Erin saved with Bob's reports over the limit going back to Bob, on an account without the beta
        await act(async () => {
            await Onyx.set(ONYXKEYS.BETAS, []);
            setApprovalWorkflow({
                ...INITIAL_APPROVAL_WORKFLOW,
                action: CONST.APPROVAL_WORKFLOW.ACTION.EDIT,
                members: [{email: DAVE_EMAIL, displayName: DAVE_EMAIL}],
                approvers: [
                    {email: BOB_EMAIL, displayName: BOB_EMAIL, approvalLimit: 5000, overLimitForwardsTo: BOB_EMAIL},
                    {email: ERIN_EMAIL, displayName: ERIN_EMAIL},
                ],
            });
        });
        await waitForBatchedUpdatesWithAct();

        // When the admin opens who else approves Bob's reports over the limit
        await renderPage(0);

        // Then Bob is not listed, as before, since nothing flags that pick without the beta, while the others still are
        const logins = getRowLogins();
        expect(logins).not.toContain(BOB_EMAIL);
        expect(logins).toContain(ERIN_EMAIL);
    });
});
