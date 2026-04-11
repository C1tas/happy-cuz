import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { useSession } from '@/sync/storage';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from './layout';

interface SessionHudBarProps {
    sessionId: string;
}

function contextBarColor(percent: number, theme: { colors: { success: string; warning: string; textDestructive: string } }): string {
    if (percent < 50) return theme.colors.success;
    if (percent < 80) return theme.colors.warning;
    return theme.colors.textDestructive;
}

function renderContextBar(percent: number): string {
    const filled = Math.round((percent / 100) * 8);
    const empty = 8 - filled;
    return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function formatCost(usd: number): string {
    if (usd < 0.01) return '$' + usd.toFixed(4);
    if (usd < 1) return '$' + usd.toFixed(2);
    return '$' + usd.toFixed(2);
}

function truncateTarget(target: string, maxLen: number): string {
    if (target.length <= maxLen) return target;
    // Show filename only for paths
    const parts = target.split('/');
    const filename = parts[parts.length - 1];
    if (filename.length <= maxLen) return filename;
    return filename.slice(0, maxLen - 3) + '...';
}

export const SessionHudBar = React.memo(({ sessionId }: SessionHudBarProps) => {
    const session = useSession(sessionId);
    const { theme } = useUnistyles();
    const hud = session?.hud;

    if (!hud) return null;

    const hasContent = hud.model || hud.contextPercent !== undefined || hud.costUsd !== undefined || hud.activeTool;
    if (!hasContent) return null;

    const segments: React.ReactNode[] = [];
    const sep = { color: theme.colors.textSecondary, opacity: 0.4 };

    if (hud.model) {
        segments.push(
            <Text key="model" style={[styles.segment, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                {hud.model}
            </Text>
        );
    }

    if (hud.contextPercent !== undefined) {
        const barColor = contextBarColor(hud.contextPercent, theme);
        if (segments.length > 0) {
            segments.push(<Text key={`sep-${segments.length}`} style={[styles.sep, sep]}>{'\u2502'}</Text>);
        }
        segments.push(
            <Text key="ctx" style={[styles.segment, { color: barColor }]} numberOfLines={1}>
                {renderContextBar(hud.contextPercent)} {Math.round(hud.contextPercent)}%
            </Text>
        );
    }

    if (hud.costUsd !== undefined && hud.costUsd > 0) {
        if (segments.length > 0) {
            segments.push(<Text key={`sep-${segments.length}`} style={[styles.sep, sep]}>{'\u2502'}</Text>);
        }
        segments.push(
            <Text key="cost" style={[styles.segment, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                {formatCost(hud.costUsd)}
            </Text>
        );
    }

    if (hud.activeTool) {
        if (segments.length > 0) {
            segments.push(<Text key={`sep-${segments.length}`} style={[styles.sep, sep]}>{'\u2502'}</Text>);
        }
        const toolText = hud.activeToolTarget
            ? `${hud.activeTool}: ${truncateTarget(hud.activeToolTarget, 20)}`
            : hud.activeTool;
        segments.push(
            <Text key="tool" style={[styles.segment, { color: theme.colors.textLink }]} numberOfLines={1}>
                {toolText}
            </Text>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.inner}>
                {segments}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 2,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    inner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    segment: {
        fontSize: 10,
        ...Typography.mono(),
    },
    sep: {
        fontSize: 10,
        ...Typography.mono(),
    },
}));
