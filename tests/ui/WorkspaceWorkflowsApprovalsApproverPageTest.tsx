import {act, render} from '@testing-library/react-native';

import type {SelectionListApprover} from '@components/ApproverSelectionList';
import ApproverSelectionList from '@components/ApproverSelectionList';
import ComposeProviders from '@components/ComposeProviders';
import {LocaleContextProvider} from '@components/LocaleContextProvider';
import OnyxListItemProvider from '@components/OnyxListItemProvider';
import PersonalDetailsByLoginProvider from '@components/PersonalDetailsByLoginProvider';

import Navigation from '@libs/Navigation/Navigation';
import {convertPolicyEmployeesToApprovalWorkflows, INITIAL_APPROVAL_WORKFLOW} from '@libs/WorkflowUtils';

import WorkspaceWorkflowsApprovalsApproverPage from '@pages/workspace/workflows/approvals/WorkspaceWorkflowsApprovalsApproverPage';

import {clearApprovalWorkflowApprover, selectApprovalWorkflowForEdit, setApprovalWorkflow} from '@userActions/Workflow';

import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import ROUTES from '@src/ROUTES';
import SCREENS from '@src/SCREENS';
import type {Policy} from '@src/types/onyx';
import type {PersonalDetailsList} from '@src/types/onyx/PersonalDetails';
import type {PolicyEmployeeList} from '@src/types/onyx/PolicyEmployee';

import type {PropsWithChildren} from 'react';

import React from 'react';
import Onyx from 'react-native-onyx';

import createMock from '../utils/createMock';
import getOnyxValue from '../utils/getOnyxValue';
import {buildPersonalDetails, localeCompare} from '../utils/TestHelper';
import waitForBatchedUpdatesWithAct from '../utils/waitForBatchedUpdatesWithAct';

const POLICY_ID = 'workflow-approver-test-policy';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_ACCOUNT_ID = 1;
const BOB_EMAIL = 'bob@example.com';
const BOB_ACCOUNT_ID = 2;
const ERIN_EMAIL = 'erin@example.com';
const ERIN_ACCOUNT_ID = 3;
const DAVE_EMAIL = 'dave@example.com';
const DAVE_ACCOUNT_ID = 4;
const REMOVED_EMAIL = 'removed@example.com';
const REMOVED_ACCOUNT_ID = 5;

// The tests read the rows the page hands the list and tap them through its callback, so the list itself renders nothing.
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

/** Bob approves Dave's reports and forwards to Erin, who still forwards to someone removed from the workspace. */
function buildEmployeeList(): PolicyEmployeeList {
    return {
        [ADMIN_EMAIL]: {email: ADMIN_EMAIL, role: CONST.POLICY.ROLE.ADMIN, submitsTo: ADMIN_EMAIL},
        [BOB_EMAIL]: {email: BOB_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL, forwardsTo: ERIN_EMAIL},
        [ERIN_EMAIL]: {email: ERIN_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL, forwardsTo: REMOVED_EMAIL},
        [DAVE_EMAIL]: {email: DAVE_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: BOB_EMAIL},
    };
}

function buildPolicy(employeeList: PolicyEmployeeList): Policy {
    return createMock<Policy>({
        id: POLICY_ID,
        name: 'Test Workspace',
        type: CONST.POLICY.TYPE.CORPORATE,
        role: CONST.POLICY.ROLE.ADMIN,
        owner: ADMIN_EMAIL,
        approver: ADMIN_EMAIL,
        approvalMode: CONST.POLICY.APPROVAL_MODE.ADVANCED,
        preventSelfApproval: true,
        areWorkflowsEnabled: true,
        employeeList,
    });
}

function buildPersonalDetailsList(): PersonalDetailsList {
    return {
        [ADMIN_ACCOUNT_ID]: buildPersonalDetails(ADMIN_EMAIL, ADMIN_ACCOUNT_ID, 'admin'),
        [BOB_ACCOUNT_ID]: buildPersonalDetails(BOB_EMAIL, BOB_ACCOUNT_ID, 'bob'),
        [ERIN_ACCOUNT_ID]: buildPersonalDetails(ERIN_EMAIL, ERIN_ACCOUNT_ID, 'erin'),
        [DAVE_ACCOUNT_ID]: buildPersonalDetails(DAVE_EMAIL, DAVE_ACCOUNT_ID, 'dave'),
        [REMOVED_ACCOUNT_ID]: buildPersonalDetails(REMOVED_EMAIL, REMOVED_ACCOUNT_ID, 'removed'),
    };
}

/** Opens Bob > Erin > removed approver for editing, the way the Workflows page builds and selects it. */
async function editWorkflowWithRemovedApprover() {
    const {approvalWorkflows} = convertPolicyEmployeesToApprovalWorkflows({
        policy: buildPolicy(buildEmployeeList()),
        personalDetails: buildPersonalDetailsList(),
        localeCompare,
        currentUserLogin: ADMIN_EMAIL,
    });
    const workflow = approvalWorkflows.find((approvalWorkflow) => approvalWorkflow.approvers.at(0)?.email === BOB_EMAIL);
    if (!workflow) {
        throw new Error("Bob's workflow was not built");
    }
    await act(async () => {
        selectApprovalWorkflowForEdit({workflow, defaultWorkflowMembers: [], usedApproverEmails: []});
    });
    await waitForBatchedUpdatesWithAct();
}

async function renderPage(approverIndex: number) {
    const result = render(
        <ComposeProviders components={[OnyxListItemProvider, PersonalDetailsByLoginProvider, LocaleContextProvider]}>
            <WorkspaceWorkflowsApprovalsApproverPage
                // @ts-expect-error - the page only reads route.name and route.params
                route={{name: SCREENS.WORKSPACE.WORKFLOWS_APPROVALS_APPROVER_CHANGE, params: {policyID: POLICY_ID, approverIndex}}}
            />
        </ComposeProviders>,
    );
    await waitForBatchedUpdatesWithAct();
    return result;
}

function getRows(): SelectionListApprover[] {
    return jest.mocked(ApproverSelectionList).mock.lastCall?.[0].allApprovers ?? [];
}

/** Taps a row the way ApproverSelectionList does with single selection: a selected row clears the selection. */
async function tapRow(email: string) {
    const listProps = jest.mocked(ApproverSelectionList).mock.lastCall?.[0];
    const row = listProps?.allApprovers.find((approver) => approver.login === email);
    if (!listProps || !row) {
        throw new Error(`${email} is not in the approver list`);
    }
    await act(async () => {
        listProps.onSelectApprover?.(row.isSelected ? [] : [{...row, isSelected: true}]);
    });
    await waitForBatchedUpdatesWithAct();
}

async function getApproverEmails() {
    const approvalWorkflow = await getOnyxValue(ONYXKEYS.APPROVAL_WORKFLOW);
    return approvalWorkflow?.approvers.map((approver) => approver?.email);
}

describe('WorkspaceWorkflowsApprovalsApproverPage', () => {
    beforeAll(() => {
        Onyx.init({keys: ONYXKEYS});
    });

    beforeEach(async () => {
        jest.mocked(ApproverSelectionList).mockClear();
        jest.mocked(Navigation.goBack).mockClear();
        await act(async () => {
            await Onyx.clear();
            await Onyx.set(ONYXKEYS.HAS_LOADED_APP, true);
            await Onyx.set(ONYXKEYS.IS_LOADING_REPORT_DATA, false);
            await Onyx.set(`${ONYXKEYS.COLLECTION.POLICY}${POLICY_ID}`, buildPolicy(buildEmployeeList()));
            await Onyx.set(ONYXKEYS.PERSONAL_DETAILS_LIST, buildPersonalDetailsList());
            await Onyx.merge(ONYXKEYS.SESSION, {email: ADMIN_EMAIL, accountID: ADMIN_ACCOUNT_ID});
        });
        await waitForBatchedUpdatesWithAct();
        await editWorkflowWithRemovedApprover();
    });

    it('lets the admin drop just the approver who left so the previous approver becomes final', async () => {
        // Given the edited workflow Bob > Erin > an approver who left the workspace
        expect(await getApproverEmails()).toEqual([BOB_EMAIL, ERIN_EMAIL, REMOVED_EMAIL]);

        // When the admin opens the approver who left
        await renderPage(2);

        // Then they are listed once, selected, even though they are no longer on employeeList
        const removedRows = getRows().filter((row) => row.login === REMOVED_EMAIL);
        expect(removedRows).toHaveLength(1);
        expect(removedRows.at(0)?.isSelected).toBe(true);

        // When the admin taps that selected row
        await tapRow(REMOVED_EMAIL);

        // Then only that approver is dropped, so Erin is the final approver, and the admin is taken back to the workflow
        expect(await getApproverEmails()).toEqual([BOB_EMAIL, ERIN_EMAIL]);
        expect(Navigation.goBack).toHaveBeenCalledWith(ROUTES.WORKSPACE_WORKFLOWS_APPROVALS_EDIT.getRoute(POLICY_ID, BOB_EMAIL, undefined), {compareParams: false});
    });

    it('never offers the approver who left as a new pick', async () => {
        // Given the edited workflow Bob > Erin > an approver who left the workspace

        // When the admin opens Erin's slot
        const {unmount} = await renderPage(1);

        // Then the approver who left can't be picked to replace Erin
        expect(getRows().some((row) => row.login === REMOVED_EMAIL)).toBe(false);
        unmount();

        // When the approver who left is removed from their slot and the admin opens that now empty slot
        await act(async () => {
            clearApprovalWorkflowApprover({approverIndex: 2, currentApprovalWorkflow: await getOnyxValue(ONYXKEYS.APPROVAL_WORKFLOW)});
        });
        await waitForBatchedUpdatesWithAct();
        await renderPage(2);

        // Then they can't be picked again
        expect(getRows().some((row) => row.login === REMOVED_EMAIL)).toBe(false);
    });

    it('lists a flagged approver only once when they are back on the workspace', async () => {
        // Given the approver who left was invited back while the edited workflow still has them flagged
        await act(async () => {
            await Onyx.merge(`${ONYXKEYS.COLLECTION.POLICY}${POLICY_ID}`, {
                employeeList: {[REMOVED_EMAIL]: {email: REMOVED_EMAIL, role: CONST.POLICY.ROLE.USER, submitsTo: ADMIN_EMAIL}},
            });
        });
        await waitForBatchedUpdatesWithAct();

        // When the admin opens their slot
        await renderPage(2);

        // Then they appear as a single selected row rather than once from employeeList and once as the flagged approver
        const removedRows = getRows().filter((row) => row.login === REMOVED_EMAIL);
        expect(removedRows).toHaveLength(1);
        expect(removedRows.at(0)?.isSelected).toBe(true);
    });

    describe("another step's additional approver for reports over the limit", () => {
        beforeEach(async () => {
            // Bob approves first, and his reports over the limit also go to Erin
            await act(async () => {
                setApprovalWorkflow({
                    ...INITIAL_APPROVAL_WORKFLOW,
                    action: CONST.APPROVAL_WORKFLOW.ACTION.CREATE,
                    members: [{email: DAVE_EMAIL, displayName: DAVE_EMAIL}],
                    approvers: [{email: BOB_EMAIL, displayName: BOB_EMAIL, approvalLimit: 5000, overLimitForwardsTo: ERIN_EMAIL}],
                });
            });
            await waitForBatchedUpdatesWithAct();
        });

        it('is not offered as the next approver with the multiple approvers beta', async () => {
            // Given the workflow is saved as approval workflow rules
            await act(async () => {
                await Onyx.set(ONYXKEYS.BETAS, [CONST.BETAS.MULTIPLE_APPROVERS]);
            });
            await waitForBatchedUpdatesWithAct();

            // When the admin picks the second approver
            await renderPage(1);

            // Then Erin can't be picked, since the save rejects an over-limit approver who also approves in the workflow,
            // while the admin still can
            const logins = getRows().map((row) => row.login);
            expect(logins).not.toContain(ERIN_EMAIL);
            expect(logins).toContain(ADMIN_EMAIL);
        });

        it('is still offered when replacing the step whose own over-limit approver they are, with the multiple approvers beta', async () => {
            // Given the workflow is saved as approval workflow rules
            await act(async () => {
                await Onyx.set(ONYXKEYS.BETAS, [CONST.BETAS.MULTIPLE_APPROVERS]);
            });
            await waitForBatchedUpdatesWithAct();

            // When the admin replaces Bob, whose own reports over the limit go to Erin
            await renderPage(0);

            // Then Erin can be picked, since picking a new approver for that step clears its limit
            expect(getRows().some((row) => row.login === ERIN_EMAIL)).toBe(true);
        });

        it('stays listed as the current pick of a step that already breaks the rule, with the multiple approvers beta', async () => {
            // Given a saved workflow Bob > Erin, where Bob's reports over the limit go to Erin, on an account with the beta
            await act(async () => {
                await Onyx.set(ONYXKEYS.BETAS, [CONST.BETAS.MULTIPLE_APPROVERS]);
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

            // When the admin opens Erin's step
            await renderPage(1);

            // Then Erin is still listed as the current pick, so the admin can see her and tap her to remove her
            expect(getRows().find((row) => row.login === ERIN_EMAIL)?.isSelected).toBe(true);
        });

        it('is still offered as the next approver without the multiple approvers beta', async () => {
            // Given the workflow is saved through the employeeList, without the beta
            // When the admin picks the second approver
            await renderPage(1);

            // Then Erin can be picked, since the employeeList routing used without the beta stays as it was
            expect(getRows().some((row) => row.login === ERIN_EMAIL)).toBe(true);
        });
    });
});
