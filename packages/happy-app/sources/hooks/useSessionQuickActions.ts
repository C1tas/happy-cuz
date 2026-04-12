import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, machineStopSession, sessionKill } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { storage, useLocalSetting, useMachine } from '@/sync/storage';
import { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { copySessionMetadataToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { useRouter } from 'expo-router';
import { RestartProgressModal, updateRestartStage, requestRestartConfirmation } from '@/components/RestartProgressModal';

interface UseSessionQuickActionsOptions {
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterCopySessionMetadata?: () => void;
}

type ResumeAvailability = {
    canResume: boolean;
    canShowResume: boolean;
    subtitle: string;
    message: string;
};

function getResumeAvailability(session: Session, machine: Machine | null | undefined, isConnected: boolean): ResumeAvailability {
    if (isConnected) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    const machineId = session.metadata?.machineId;
    if (!machineId) {
        const message = t('sessionInfo.resumeSessionMissingMachine');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    const hasBackendResumeId = Boolean(session.metadata?.claudeSessionId || session.metadata?.codexThreadId);
    if (!hasBackendResumeId) {
        const message = t('sessionInfo.resumeSessionMissingBackendId');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!machine) {
        const message = t('sessionInfo.resumeSessionSameMachineOnly');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!isMachineOnline(machine)) {
        return {
            canResume: false,
            canShowResume: true,
            subtitle: t('sessionInfo.resumeSessionMachineOffline'),
            message: t('sessionInfo.resumeSessionMachineOffline'),
        };
    }

    if (!machine.metadata?.resumeSupport?.rpcAvailable) {
        return {
            canResume: false,
            canShowResume: true,
            subtitle: t('sessionInfo.resumeSessionNeedsHappyAgent'),
            message: t('sessionInfo.resumeSessionNeedsHappyAgent'),
        };
    }

    return {
        canResume: true,
        canShowResume: true,
        subtitle: t('sessionInfo.resumeSessionSubtitle'),
        message: t('sessionInfo.resumeSessionSubtitle'),
    };
}

type RestartAvailability = {
    canRestart: boolean;
    canShowRestart: boolean;
    subtitle: string;
};

/**
 * Restart availability: requires the session to be connected (opposite of resume),
 * plus the same daemon/machine conditions needed for resume.
 */
function getRestartAvailability(session: Session, machine: Machine | null | undefined, _isConnected: boolean): RestartAvailability {
    const machineId = session.metadata?.machineId;
    if (!machineId) {
        return { canRestart: false, canShowRestart: false, subtitle: '' };
    }

    const hasBackendId = Boolean(session.metadata?.claudeSessionId || session.metadata?.codexThreadId);
    if (!hasBackendId) {
        return { canRestart: false, canShowRestart: true, subtitle: t('sessionInfo.restartSessionMissingBackendId') };
    }

    if (!machine || !isMachineOnline(machine)) {
        return { canRestart: false, canShowRestart: true, subtitle: t('sessionInfo.restartSessionMachineOffline') };
    }

    if (!machine.metadata?.resumeSupport?.rpcAvailable) {
        return { canRestart: false, canShowRestart: true, subtitle: t('sessionInfo.restartSessionNeedsUpdate') };
    }

    return { canRestart: true, canShowRestart: true, subtitle: t('sessionInfo.restartSessionSubtitle') };
}

export function useSessionQuickActions(
    session: Session,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterArchive,
        onAfterCopySessionMetadata,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const resumeAvailability = React.useMemo(
        () => getResumeAvailability(session, machine, sessionStatus.isConnected),
        [machine, session, sessionStatus.isConnected],
    );
    const restartAvailability = React.useMemo(
        () => getRestartAvailability(session, machine, sessionStatus.isConnected),
        [machine, session, sessionStatus.isConnected],
    );

    const openDetails = React.useCallback(() => {
        router.push(`/session/${session.id}/info`);
    }, [router, session.id]);

    const copySessionMetadata = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const [resumingSession, performResume] = useHappyAction(async () => {
        if (!resumeAvailability.canResume) {
            throw new HappyError(resumeAvailability.message, false);
        }

        if (!machineId) {
            throw new HappyError(t('sessionInfo.resumeSessionMissingMachine'), false);
        }

        const result = await machineResumeSession({
            machineId,
            sessionId: session.id,
        });

        switch (result.type) {
            case 'success': {
                for (let attempt = 0; attempt < 3; attempt++) {
                    await sync.refreshSessions();
                    if (storage.getState().sessions[result.sessionId]) {
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 150));
                }

                if (session.permissionMode) {
                    storage.getState().updateSessionPermissionMode(result.sessionId, session.permissionMode);
                }
                if (session.modelMode) {
                    storage.getState().updateSessionModelMode(result.sessionId, session.modelMode);
                }

                navigateToSession(result.sessionId);
                return;
            }
            case 'requestToApproveDirectoryCreation':
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                throw new HappyError(result.errorMessage, false);
        }
    });

    const [archivingSession, performArchive] = useHappyAction(async () => {
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

        const result = await sessionKill(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
        }
        onAfterArchive?.();
    });

    const [restartingSession, performRestart] = useHappyAction(async () => {
        console.log('[Restart] Starting restart flow, canRestart:', restartAvailability.canRestart, 'machineId:', machineId);
        if (!restartAvailability.canRestart || !machineId) {
            throw new HappyError(restartAvailability.subtitle, false);
        }

        const modalId = Modal.show({ component: RestartProgressModal });
        console.log('[Restart] Modal.show called, modalId:', modalId);

        // Yield to allow React to render the modal and register the stageListener
        // Without this, updateRestartStage fires before the modal mounts and events are lost
        await new Promise(resolve => setTimeout(resolve, 50));
        console.log('[Restart] Modal mount delay complete');

        try {
            // Stage 1: Check if session is active
            console.log('[Restart] Setting stage: checking, sessionStatus.isConnected:', sessionStatus.isConnected, 'state:', sessionStatus.state);
            updateRestartStage({ type: 'checking' });

            // If session is actively running, ask user for confirmation
            if (sessionStatus.isConnected) {
                console.log('[Restart] Session is connected, requesting confirmation...');
                const confirmed = await requestRestartConfirmation(sessionStatus.state);
                console.log('[Restart] Confirmation result:', confirmed);
                if (!confirmed) {
                    Modal.hide(modalId);
                    return;
                }

                // Stage 2: Stop the running session
                console.log('[Restart] Stopping session, machineId:', machineId, 'sessionId:', session.id);
                updateRestartStage({
                    type: 'stopping',
                    sessionId: session.id,
                    pid: session.metadata?.hostPid ?? undefined,
                });
                await machineStopSession(machineId, session.id);
                console.log('[Restart] Session stopped successfully');
                updateRestartStage({ type: 'stopped', sessionId: session.id });
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }

            // Stage 3: Resume with new process (reusing same session ID)
            console.log('[Restart] Starting resume, machineId:', machineId, 'sessionId:', session.id);
            updateRestartStage({ type: 'starting', sessionId: session.id });
            const result = await machineResumeSession({ machineId, sessionId: session.id });
            console.log('[Restart] Resume result:', result.type, result.type === 'success' ? result.sessionId : '');

            if (result.type === 'requestToApproveDirectoryCreation') {
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            }
            if (result.type === 'error') {
                throw new HappyError(result.errorMessage, false);
            }

            updateRestartStage({
                type: 'started',
                sessionId: session.id,
                newSessionId: result.sessionId,
            });

            // Stage 4: Load conversation history
            console.log('[Restart] Loading conversation history');
            updateRestartStage({ type: 'loading' });
            for (let attempt = 0; attempt < 3; attempt++) {
                await sync.refreshSessions();
                if (storage.getState().sessions[result.sessionId]) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 150));
            }

            if (session.permissionMode) {
                storage.getState().updateSessionPermissionMode(result.sessionId, session.permissionMode);
            }
            if (session.modelMode) {
                storage.getState().updateSessionModelMode(result.sessionId, session.modelMode);
            }

            Modal.hide(modalId);
            console.log('[Restart] Complete, navigating to session:', result.sessionId);
            navigateToSession(result.sessionId);
        } catch (error) {
            console.log('[Restart] Error caught:', error instanceof HappyError ? error.message : error);
            if (error instanceof HappyError) {
                // Show error in progress modal instead of the default useHappyAction alert
                updateRestartStage({ type: 'error', message: error.message });
                // Don't re-throw — let user close the modal manually
                return;
            } else {
                Modal.hide(modalId);
            }
            throw error;
        }
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    const resumeSession = React.useCallback(() => {
        performResume();
    }, [performResume]);

    const restartSession = React.useCallback(() => {
        performRestart();
    }, [performRestart]);

    return {
        archiveSession,
        archivingSession,
        canArchive: sessionStatus.isConnected,
        canCopySessionMetadata: __DEV__ || devModeEnabled,
        canRestart: restartAvailability.canRestart,
        canShowRestart: restartAvailability.canShowRestart,
        canResume: resumeAvailability.canResume,
        canShowResume: resumeAvailability.canShowResume,
        copySessionMetadata,
        openDetails,
        restartSession,
        restartSessionSubtitle: restartAvailability.subtitle,
        restartingSession,
        resumeSession,
        resumeSessionSubtitle: resumeAvailability.subtitle,
        resumingSession,
    };
}
