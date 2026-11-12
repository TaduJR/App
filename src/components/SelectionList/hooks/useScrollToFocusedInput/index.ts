import type {MeasurableInput} from '@components/SelectionList/SelectionListWithSections/types';

import type {ComponentRef} from 'react';
import type {View} from 'react-native';

import {useRef} from 'react';

import type {UseScrollToFocusedInput} from './types';

const noop = () => {};

/**
 * Browsers already scroll a focused input into view, so on web only revealing a view that isn't focused needs work.
 * `containerRef` is still returned so the list can attach it harmlessly.
 */
const useScrollToFocusedInput: UseScrollToFocusedInput = (listRef) => {
    const containerRef = useRef<ComponentRef<typeof View> | null>(null);

    const scrollToReveal = (view: MeasurableInput) => {
        const scroller = listRef.current?.getNativeScrollRef();
        if (!(view instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
            return;
        }
        // An error renders at the bottom of its field, so a field taller than the visible list is aligned by its bottom.
        const doesViewFit = view.getBoundingClientRect().height <= scroller.getBoundingClientRect().height;
        view.scrollIntoView({block: doesViewFit ? 'nearest' : 'end', behavior: 'smooth'});
    };

    return {containerRef, trackScrollOffset: noop, scrollInputIntoView: noop, scrollToReveal};
};

export default useScrollToFocusedInput;
