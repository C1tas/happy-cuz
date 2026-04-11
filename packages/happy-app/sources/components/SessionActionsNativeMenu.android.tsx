import * as React from 'react';
import { DropdownMenu, DropdownMenuItem, Text } from '@expo/ui/jetpack-compose';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';

interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    session: Session;
}

export function SessionActionsNativeMenu({
    children,
    onAfterArchive,
    onAfterDelete,
    session,
}: SessionActionsNativeMenuProps) {
    const {
        archiveSession,
        canArchive,
        canCopySessionMetadata,
        canShowResume,
        copySessionMetadata,
        openDetails,
        resumeSession,
    } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterDelete,
    });

    return (
        <DropdownMenu>
            <DropdownMenu.Items>
                <DropdownMenuItem onClick={openDetails}>
                    <DropdownMenuItem.Text><Text>Details</Text></DropdownMenuItem.Text>
                </DropdownMenuItem>
                {canArchive ? (
                    <DropdownMenuItem onClick={archiveSession}>
                        <DropdownMenuItem.Text><Text>Archive</Text></DropdownMenuItem.Text>
                    </DropdownMenuItem>
                ) : null}
                {canShowResume ? (
                    <DropdownMenuItem onClick={resumeSession}>
                        <DropdownMenuItem.Text><Text>Resume</Text></DropdownMenuItem.Text>
                    </DropdownMenuItem>
                ) : null}
                {canCopySessionMetadata ? (
                    <DropdownMenuItem onClick={copySessionMetadata}>
                        <DropdownMenuItem.Text><Text>{t('sessionInfo.copyMetadata')}</Text></DropdownMenuItem.Text>
                    </DropdownMenuItem>
                ) : null}
            </DropdownMenu.Items>
            <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
        </DropdownMenu>
    );
}
