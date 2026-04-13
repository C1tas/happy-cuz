import * as React from 'react';
import { useSession, useSessionMessages } from "@/sync/storage";
import { ActivityIndicator, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform, View } from 'react-native';
import { useCallback } from 'react';
import { useHeaderHeight } from '@/utils/responsive';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageView } from './MessageView';
import { Metadata, Session } from '@/sync/storageTypes';
import { ChatFooter } from './ChatFooter';
import { Message } from '@/sync/typesMessage';
import { sync } from '@/sync/sync';

export type ChatListHandle = {
    scrollToBottom: () => void;
};

export const ChatList = React.memo(React.forwardRef<ChatListHandle, { session: Session }>((props, ref) => {
    const { messages, hasOlderMessages, isLoadingOlder } = useSessionMessages(props.session.id);
    const internalRef = React.useRef<ChatListHandle>(null);
    React.useImperativeHandle(ref, () => ({
        scrollToBottom: () => internalRef.current?.scrollToBottom(),
    }));
    return (
        <ChatListInternal
            ref={internalRef}
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            hasOlderMessages={hasOlderMessages}
            isLoadingOlder={isLoadingOlder}
        />
    )
}));

const ListHeader = React.memo(() => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />;
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return (
        <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />
    )
});

const LoadOlderIndicator = React.memo((props: { isLoading: boolean }) => {
    if (!props.isLoading) return null;
    return (
        <View style={{ paddingVertical: 12, alignItems: 'center' }}>
            <ActivityIndicator size="small" color="#999" />
        </View>
    );
});

/** Distance from scroll edge (in dp) to trigger loading older messages */
const LOAD_THRESHOLD = 200;

const ChatListInternal = React.memo(React.forwardRef<ChatListHandle, {
    metadata: Metadata | null,
    sessionId: string,
    messages: Message[],
    hasOlderMessages: boolean,
    isLoadingOlder: boolean,
}>((props, ref) => {
    const flatListRef = React.useRef<FlatList>(null);

    React.useImperativeHandle(ref, () => ({
        scrollToBottom: () => {
            flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
        },
    }));

    const keyExtractor = useCallback((item: any) => item.id, []);
    const renderItem = useCallback(({ item }: { item: any }) => (
        <MessageView message={item} metadata={props.metadata} sessionId={props.sessionId} />
    ), [props.metadata, props.sessionId]);

    const tryLoadOlder = useCallback(() => {
        if (props.hasOlderMessages && !props.isLoadingOlder) {
            sync.loadOlderMessages(props.sessionId);
        }
    }, [props.sessionId, props.hasOlderMessages, props.isLoadingOlder]);

    // onEndReached works reliably on iOS for inverted lists.
    // On Android it's unreliable, so we use onScroll to detect proximity to the top.
    const handleEndReached = useCallback(() => {
        if (Platform.OS !== 'android') {
            tryLoadOlder();
        }
    }, [tryLoadOlder]);

    const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (Platform.OS !== 'android' || !props.hasOlderMessages || props.isLoadingOlder) return;
        // In inverted FlatList, scrollY measures distance from the bottom edge.
        // When user scrolls toward older messages (top of visual list), scrollY increases.
        // Distance from the "end" (top of visual list) = contentHeight - layoutHeight - scrollY
        const { contentSize, layoutMeasurement, contentOffset } = e.nativeEvent;
        const distanceFromTop = contentSize.height - layoutMeasurement.height - contentOffset.y;
        if (distanceFromTop < LOAD_THRESHOLD) {
            tryLoadOlder();
        }
    }, [props.hasOlderMessages, props.isLoadingOlder, tryLoadOlder]);

    return (
        <FlatList
            ref={flatListRef}
            data={props.messages}
            inverted={true}
            keyExtractor={keyExtractor}
            maintainVisibleContentPosition={{
                minIndexForVisible: 0,
                autoscrollToTopThreshold: 10,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
            renderItem={renderItem}
            ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
            ListFooterComponent={
                <View>
                    <LoadOlderIndicator isLoading={props.isLoadingOlder} />
                    <ListHeader />
                </View>
            }
            onEndReached={props.hasOlderMessages ? handleEndReached : undefined}
            onEndReachedThreshold={0.5}
            onScroll={Platform.OS === 'android' ? handleScroll : undefined}
            removeClippedSubviews={false}
            windowSize={5}
            maxToRenderPerBatch={8}
            initialNumToRender={12}
        />
    )
}));
