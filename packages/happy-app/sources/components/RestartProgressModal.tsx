import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { t } from '@/text';

//
// Restart stage types and module-level communication
//

export type RestartStage =
    | { type: 'checking' }
    | { type: 'confirm_active'; state: string }
    | { type: 'stopping'; sessionId: string; pid?: number }
    | { type: 'stopped'; sessionId: string }
    | { type: 'starting'; sessionId: string }
    | { type: 'started'; sessionId: string; newSessionId: string }
    | { type: 'loading' }
    | { type: 'error'; message: string };

let stageListener: ((stage: RestartStage) => void) | null = null;
let confirmResolver: ((confirmed: boolean) => void) | null = null;

/**
 * Push a stage update to the modal from imperative async code.
 */
export function updateRestartStage(stage: RestartStage) {
    console.log('[RestartProgress] updateRestartStage:', stage.type, 'listener set:', stageListener !== null);
    stageListener?.(stage);
}

/**
 * Show confirm_active stage and wait for user decision.
 * Returns true if user confirmed, false if cancelled.
 */
export function requestRestartConfirmation(state: string): Promise<boolean> {
    console.log('[RestartProgress] requestRestartConfirmation called, state:', state);
    return new Promise((resolve) => {
        confirmResolver = resolve;
        updateRestartStage({ type: 'confirm_active', state });
    });
}

//
// Modal component
//

interface RestartProgressModalProps {
    onClose: () => void;
}

export function RestartProgressModal({ onClose }: RestartProgressModalProps) {
    const [stage, setStage] = React.useState<RestartStage>({ type: 'checking' });
    const stageRef = React.useRef<RestartStage>(stage);

    React.useEffect(() => {
        console.log('[RestartProgress] Modal mounted, registering stageListener');
        stageListener = (s) => {
            console.log('[RestartProgress] stageListener received:', s.type);
            stageRef.current = s;
            setStage(s);
        };
        return () => {
            console.log('[RestartProgress] Modal unmounting, clearing stageListener');
            stageListener = null;
            // Reject any pending confirmation on unmount
            if (confirmResolver) {
                confirmResolver(false);
                confirmResolver = null;
            }
        };
    }, []);

    // Only allow backdrop dismiss during confirm_active and error stages
    const guardedOnClose = React.useCallback(() => {
        const current = stageRef.current;
        if (current.type === 'confirm_active') {
            if (confirmResolver) {
                confirmResolver(false);
                confirmResolver = null;
            }
            onClose();
        } else if (current.type === 'error') {
            onClose();
        }
        // Otherwise: ignore backdrop tap during in-progress operations
    }, [onClose]);

    const handleConfirm = React.useCallback(() => {
        if (confirmResolver) {
            confirmResolver(true);
            confirmResolver = null;
        }
    }, []);

    return (
        <View style={styles.container}>
            {renderStageContent(stage, handleConfirm, guardedOnClose, guardedOnClose)}
        </View>
    );
}

function renderStageContent(
    stage: RestartStage,
    onConfirm: () => void,
    onCancel: () => void,
    onClose: () => void,
) {
    switch (stage.type) {
        case 'checking':
            return (
                <>
                    <ActivityIndicator size="small" style={styles.indicator} />
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {t('sessionInfo.restartProgressChecking')}
                    </Text>
                </>
            );

        case 'confirm_active':
            return (
                <>
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {t('sessionInfo.restartProgressActiveTitle')}
                    </Text>
                    <Text style={[styles.message, Typography.default()]}>
                        {t('sessionInfo.restartProgressActiveMessage', { state: stage.state })}
                    </Text>
                    <View style={styles.buttonRow}>
                        <View style={styles.buttonHalf}>
                            <RoundButton
                                title={t('common.cancel')}
                                onPress={onCancel}
                                size="normal"
                                display="inverted"
                            />
                        </View>
                        <View style={styles.buttonHalf}>
                            <RoundButton
                                title={t('sessionInfo.restartProgressConfirm')}
                                onPress={onConfirm}
                                size="normal"
                            />
                        </View>
                    </View>
                </>
            );

        case 'stopping':
            return (
                <>
                    <ActivityIndicator size="small" style={styles.indicator} />
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {t('sessionInfo.restartProgressStopping')}
                    </Text>
                    <Text style={[styles.message, Typography.default()]}>
                        {stage.pid
                            ? `PID ${stage.pid} — ${stage.sessionId}`
                            : stage.sessionId}
                    </Text>
                </>
            );

        case 'stopped':
            return (
                <>
                    <Text style={[styles.checkmark]}>{'✓'}</Text>
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {t('sessionInfo.restartProgressStopped')}
                    </Text>
                    <Text style={[styles.message, Typography.default()]}>
                        {stage.sessionId}
                    </Text>
                </>
            );

        case 'starting':
            return (
                <>
                    <ActivityIndicator size="small" style={styles.indicator} />
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {t('sessionInfo.restartProgressStarting')}
                    </Text>
                    <Text style={[styles.message, Typography.default()]}>
                        {stage.sessionId}
                    </Text>
                </>
            );

        case 'started':
            return (
                <>
                    <Text style={[styles.checkmark]}>{'✓'}</Text>
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {t('sessionInfo.restartProgressStarted')}
                    </Text>
                    <Text style={[styles.message, Typography.default()]}>
                        {stage.newSessionId}
                    </Text>
                </>
            );

        case 'loading':
            return (
                <>
                    <ActivityIndicator size="small" style={styles.indicator} />
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {t('sessionInfo.restartProgressLoading')}
                    </Text>
                </>
            );

        case 'error':
            return (
                <>
                    <Text style={[styles.errorMark]}>{'!'}</Text>
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {t('sessionInfo.restartProgressError')}
                    </Text>
                    <Text style={[styles.message, Typography.default()]}>
                        {stage.message}
                    </Text>
                    <View style={styles.buttons}>
                        <RoundButton
                            title={t('common.ok')}
                            onPress={onClose}
                            size="normal"
                        />
                    </View>
                </>
            );
    }
}

//
// Styles
//

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        padding: 24,
        width: 320,
        alignItems: 'center',
    },
    indicator: {
        marginBottom: 16,
    },
    title: {
        fontSize: 17,
        color: theme.colors.text,
        textAlign: 'center',
        marginBottom: 8,
    },
    message: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 16,
    },
    checkmark: {
        fontSize: 28,
        color: theme.colors.success,
        marginBottom: 12,
    },
    errorMark: {
        fontSize: 28,
        color: theme.colors.warning,
        marginBottom: 12,
    },
    buttons: {
        width: '100%',
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        width: '100%',
    },
    buttonHalf: {
        flex: 1,
    },
}));
