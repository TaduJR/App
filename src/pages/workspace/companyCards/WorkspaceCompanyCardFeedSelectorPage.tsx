import React from 'react';
import HeaderWithBackButton from '@components/HeaderWithBackButton';
import Icon from '@components/Icon';
import * as Expensicons from '@components/Icon/Expensicons';
import MenuItem from '@components/MenuItem';
import PlaidCardFeedIcon from '@components/PlaidCardFeedIcon';
import ScreenWrapper from '@components/ScreenWrapper';
import SelectionList from '@components/SelectionList';
import RadioListItem from '@components/SelectionList/RadioListItem';
import type {ListItem} from '@components/SelectionList/types';
import useCardFeeds from '@hooks/useCardFeeds';
import useLocalize from '@hooks/useLocalize';
import useOnyx from '@hooks/useOnyx';
import usePolicy from '@hooks/usePolicy';
import useThemeIllustrations from '@hooks/useThemeIllustrations';
import useThemeStyles from '@hooks/useThemeStyles';
import {
    checkIfFeedConnectionIsBroken,
    filterInactiveCards,
    getCardFeedIcon,
    getCompanyFeeds,
    getCustomOrFormattedFeedName,
    getDomainOrWorkspaceAccountID,
    getPlaidInstitutionIconUrl,
    getSelectedFeed,
} from '@libs/CardUtils';
import type {PlatformStackScreenProps} from '@libs/Navigation/PlatformStackNavigation/types';
import type {SettingsNavigatorParamList} from '@libs/Navigation/types';
import {isCollectPolicy} from '@libs/PolicyUtils';
import Navigation from '@navigation/Navigation';
import AccessOrNotFoundWrapper from '@pages/workspace/AccessOrNotFoundWrapper';
import variables from '@styles/variables';
import {updateSelectedFeed} from '@userActions/Card';
import {clearAddNewCardFlow} from '@userActions/CompanyCards';
import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import ROUTES from '@src/ROUTES';
import type SCREENS from '@src/SCREENS';
import type {CompanyCardFeed} from '@src/types/onyx';

type CardFeedListItem = ListItem & {
    /** Card feed value */
    value: CompanyCardFeed;
};

type WorkspaceCompanyCardFeedSelectorPageProps = PlatformStackScreenProps<SettingsNavigatorParamList, typeof SCREENS.WORKSPACE.COMPANY_CARDS_SELECT_FEED>;

function WorkspaceCompanyCardFeedSelectorPage({route}: WorkspaceCompanyCardFeedSelectorPageProps) {
    const {policyID} = route.params;
    const policy = usePolicy(policyID);
    const workspaceAccountID = policy?.workspaceAccountID ?? CONST.DEFAULT_NUMBER_ID;

    const {translate} = useLocalize();
    const styles = useThemeStyles();
    const illustrations = useThemeIllustrations();
    const [cardFeeds] = useCardFeeds(policyID);
    const [allFeedsCards] = useOnyx(`${ONYXKEYS.COLLECTION.WORKSPACE_CARDS_LIST}`, {canBeMissing: false});
    const [lastSelectedFeed] = useOnyx(`${ONYXKEYS.COLLECTION.LAST_SELECTED_FEED}${policyID}`, {canBeMissing: true});
    const selectedFeed = getSelectedFeed(lastSelectedFeed, cardFeeds);
    const companyFeeds = getCompanyFeeds(cardFeeds);
    const isCollect = isCollectPolicy(policy);

    const feeds: CardFeedListItem[] = Object.entries(companyFeeds).map(([key, feedSettings]) => {
        const feed = key as CompanyCardFeed;
        const filteredFeedCards = filterInactiveCards(
            allFeedsCards?.[`${ONYXKEYS.COLLECTION.WORKSPACE_CARDS_LIST}${getDomainOrWorkspaceAccountID(workspaceAccountID, feedSettings)}_${feed}`],
        );
        const isFeedConnectionBroken = checkIfFeedConnectionIsBroken(filteredFeedCards);
        const plaidUrl = getPlaidInstitutionIconUrl(feed);

        return {
            value: feed,
            text: getCustomOrFormattedFeedName(feed, cardFeeds?.settings?.companyCardNicknames),
            keyForList: feed,
            isSelected: feed === selectedFeed,
            isDisabled: companyFeeds[feed]?.pendingAction === CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE,
            pendingAction: companyFeeds[feed]?.pendingAction,
            brickRoadIndicator: isFeedConnectionBroken ? CONST.BRICK_ROAD_INDICATOR_STATUS.ERROR : undefined,
            canShowSeveralIndicators: isFeedConnectionBroken,
            leftElement: plaidUrl ? (
                <PlaidCardFeedIcon
                    plaidUrl={plaidUrl}
                    style={styles.mr3}
                />
            ) : (
                <Icon
                    src={getCardFeedIcon(feed, illustrations)}
                    height={variables.cardIconHeight}
                    width={variables.cardIconWidth}
                    additionalStyles={[styles.mr3, styles.cardIcon]}
                />
            ),
        };
    });

    const onAddCardsPress = () => {
        clearAddNewCardFlow();
        if (isCollect && feeds.length === 1) {
            Navigation.navigate(
                ROUTES.WORKSPACE_UPGRADE.getRoute(policyID, CONST.UPGRADE_FEATURE_INTRO_MAPPING.companyCards.alias, ROUTES.WORKSPACE_COMPANY_CARDS_SELECT_FEED.getRoute(policyID)),
            );
            return;
        }
        Navigation.navigate(ROUTES.WORKSPACE_COMPANY_CARDS_ADD_NEW.getRoute(policyID));
    };

    const goBack = () => Navigation.goBack(ROUTES.WORKSPACE_COMPANY_CARDS.getRoute(policyID));

    const selectFeed = (feed: CardFeedListItem) => {
        updateSelectedFeed(feed.value, policyID);
        goBack();
    };

    return (
        <AccessOrNotFoundWrapper
            policyID={policyID}
            featureName={CONST.POLICY.MORE_FEATURES.ARE_COMPANY_CARDS_ENABLED}
        >
            <ScreenWrapper
                testID={WorkspaceCompanyCardFeedSelectorPage.displayName}
                shouldEnablePickerAvoiding={false}
                shouldEnableMaxHeight
                enableEdgeToEdgeBottomSafeAreaPadding
            >
                <HeaderWithBackButton
                    title={translate('workspace.companyCards.selectCards')}
                    onBackButtonPress={goBack}
                />
                <SelectionList
                    ListItem={RadioListItem}
                    onSelectRow={selectFeed}
                    sections={[{data: feeds}]}
                    shouldUpdateFocusedIndex
                    isAlternateTextMultilineSupported
                    initiallyFocusedOptionKey={selectedFeed}
                    addBottomSafeAreaPadding
                    listFooterContent={
                        <MenuItem
                            title={translate('workspace.companyCards.addCards')}
                            icon={Expensicons.Plus}
                            onPress={onAddCardsPress}
                        />
                    }
                />
            </ScreenWrapper>
        </AccessOrNotFoundWrapper>
    );
}

WorkspaceCompanyCardFeedSelectorPage.displayName = 'WorkspaceCompanyCardFeedSelectorPage';

export default WorkspaceCompanyCardFeedSelectorPage;
