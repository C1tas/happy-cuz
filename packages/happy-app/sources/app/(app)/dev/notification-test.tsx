import React, { memo, useCallback, useState, useEffect } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/AuthContext';
import { getCurrentExpoPushToken, getPushPermissionInfo, requestPushPermissionOrOpenSettings, type PushPermissionInfo } from '@/sync/pushRegistration';
import { registerPushToken, fetchPushTokens, unregisterPushToken } from '@/sync/apiPush';

interface DiagnosticEntry {
    label: string;
    value: string;
    status: 'ok' | 'warn' | 'error' | 'info';
}

export default memo(function NotificationTestScreen() {
    const auth = useAuth();
    const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
    const [permissionInfo, setPermissionInfo] = useState<PushPermissionInfo | null>(null);
    const [pushToken, setPushToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [serverTokens, setServerTokens] = useState<{ id: string; token: string; createdAt: number }[]>([]);

    // Run diagnostics on mount
    useEffect(() => {
        runDiagnostics();
    }, []);

    const runDiagnostics = useCallback(async () => {
        const entries: DiagnosticEntry[] = [];

        // 1. Platform
        entries.push({
            label: 'Platform',
            value: `${Platform.OS} ${Platform.Version}`,
            status: 'info',
        });

        // 2. Is physical device
        entries.push({
            label: 'Physical Device',
            value: Device.isDevice ? 'Yes' : 'No (Simulator/Emulator)',
            status: Device.isDevice ? 'ok' : 'warn',
        });

        // 3. __DEV__ mode
        entries.push({
            label: '__DEV__ mode',
            value: __DEV__ ? 'true (push registration SKIPPED in sync.ts)' : 'false (push registration enabled)',
            status: __DEV__ ? 'error' : 'ok',
        });

        // 4. App variant / package
        const bundleId = Platform.OS === 'android'
            ? Application.applicationId
            : Constants.expoConfig?.ios?.bundleIdentifier;
        entries.push({
            label: 'Bundle/Package ID',
            value: bundleId || 'unknown',
            status: bundleId === 'com.c1tas.happycuz' ? 'info' : 'info',
        });

        // 5. App name
        entries.push({
            label: 'App Name',
            value: Constants.expoConfig?.name || Application.applicationName || 'unknown',
            status: 'info',
        });

        // 6. EAS Project ID
        const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
        entries.push({
            label: 'EAS Project ID',
            value: projectId || 'NOT FOUND',
            status: projectId ? 'ok' : 'error',
        });

        // 7. Expo slug
        entries.push({
            label: 'Expo Slug',
            value: Constants.expoConfig?.slug || 'unknown',
            status: 'info',
        });

        // 8. Expo Owner
        entries.push({
            label: 'Expo Owner',
            value: Constants.expoConfig?.owner || 'unknown',
            status: 'info',
        });

        // 9. Permission status
        try {
            const perm = await getPushPermissionInfo();
            setPermissionInfo(perm);
            entries.push({
                label: 'Notification Permission',
                value: `${perm.status} (granted=${perm.granted}, canAskAgain=${perm.canAskAgain})`,
                status: perm.granted ? 'ok' : perm.status === 'undetermined' ? 'warn' : 'error',
            });
        } catch (e: any) {
            entries.push({
                label: 'Notification Permission',
                value: `Error: ${e.message}`,
                status: 'error',
            });
        }

        // 10. Try to get Expo push token
        try {
            const token = await getCurrentExpoPushToken();
            setPushToken(token);
            entries.push({
                label: 'Expo Push Token',
                value: token || 'null (failed to acquire)',
                status: token ? 'ok' : 'error',
            });
        } catch (e: any) {
            entries.push({
                label: 'Expo Push Token',
                value: `Error: ${e.message}`,
                status: 'error',
            });
        }

        // 11. Try to get device (FCM) push token
        if (Platform.OS !== 'web') {
            try {
                const deviceToken = await Notifications.getDevicePushTokenAsync();
                entries.push({
                    label: 'Device (FCM) Token',
                    value: typeof deviceToken.data === 'string'
                        ? deviceToken.data.substring(0, 40) + '...'
                        : JSON.stringify(deviceToken.data).substring(0, 40) + '...',
                    status: 'ok',
                });
            } catch (e: any) {
                entries.push({
                    label: 'Device (FCM) Token',
                    value: `Error: ${e.message}`,
                    status: 'error',
                });
            }
        }

        // 12. Android notification channels
        if (Platform.OS === 'android') {
            try {
                const channels = await Notifications.getNotificationChannelsAsync();
                entries.push({
                    label: 'Android Channels',
                    value: channels.map(c => `${c.id}(imp=${c.importance})`).join(', ') || 'none',
                    status: channels.length > 0 ? 'ok' : 'warn',
                });
            } catch (e: any) {
                entries.push({
                    label: 'Android Channels',
                    value: `Error: ${e.message}`,
                    status: 'error',
                });
            }
        }

        // 13. Auth status
        entries.push({
            label: 'Auth Credentials',
            value: auth.credentials ? 'Available' : 'Not authenticated',
            status: auth.credentials ? 'ok' : 'warn',
        });

        setDiagnostics(entries);
    }, [auth.credentials]);

    // Request permission
    const handleRequestPermission = useCallback(async () => {
        setLoading(true);
        try {
            const result = await requestPushPermissionOrOpenSettings();
            setPermissionInfo(result.permission);
            if (result.granted) {
                Modal.alert('Permission Granted', 'Push notification permission is now granted.');
            } else if (result.openedSettings) {
                Modal.alert('Settings Opened', 'Please enable notifications in system settings, then return.');
            } else {
                Modal.alert('Permission Denied', `Status: ${result.permission.status}`);
            }
            await runDiagnostics();
        } finally {
            setLoading(false);
        }
    }, [runDiagnostics]);

    // Send local notification
    const handleLocalNotification = useCallback(async () => {
        try {
            const id = await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Local Test Notification',
                    body: `Test at ${new Date().toLocaleTimeString()} from ${Application.applicationId || 'unknown'}`,
                    data: { test: true, timestamp: Date.now() },
                    sound: true,
                },
                trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 2 },
            });
            Modal.alert('Scheduled', `Local notification scheduled (id: ${id}). Will fire in 2 seconds.`);
        } catch (e: any) {
            Modal.alert('Error', `Failed to schedule local notification: ${e.message}`);
        }
    }, []);

    // Register token to server
    const handleRegisterToken = useCallback(async () => {
        if (!auth.credentials) {
            Modal.alert('Error', 'Not authenticated');
            return;
        }
        setLoading(true);
        try {
            const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
            if (!projectId) {
                Modal.alert('Error', 'No EAS projectId found');
                return;
            }

            let token: string;
            try {
                const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
                token = tokenData.data;
            } catch (e: any) {
                Modal.alert('Token Error', `getExpoPushTokenAsync failed: ${e.message}`);
                return;
            }

            setPushToken(token);

            try {
                await registerPushToken(auth.credentials, token);
                Modal.alert('Registered', `Token registered on server:\n${token}`);
            } catch (e: any) {
                Modal.alert('Server Error', `registerPushToken failed: ${e.message}`);
            }
        } finally {
            setLoading(false);
        }
    }, [auth.credentials]);

    // Fetch server tokens
    const handleFetchServerTokens = useCallback(async () => {
        if (!auth.credentials) {
            Modal.alert('Error', 'Not authenticated');
            return;
        }
        setLoading(true);
        try {
            const tokens = await fetchPushTokens(auth.credentials);
            setServerTokens(tokens);
            if (tokens.length === 0) {
                Modal.alert('No Tokens', 'No push tokens registered on server for this account.');
            }
        } catch (e: any) {
            Modal.alert('Error', `fetchPushTokens failed: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [auth.credentials]);

    // Copy token to clipboard
    const handleCopyToken = useCallback(async (token: string) => {
        await Clipboard.setStringAsync(token);
        Modal.alert('Copied', 'Token copied to clipboard. Use https://expo.dev/notifications to send a test push.');
    }, []);

    // Full round-trip test
    const handleFullTest = useCallback(async () => {
        if (!auth.credentials) {
            Modal.alert('Error', 'Not authenticated');
            return;
        }
        setLoading(true);
        const results: string[] = [];

        try {
            // Step 1: Permission
            const perm = await getPushPermissionInfo();
            results.push(`1. Permission: ${perm.status} (granted=${perm.granted})`);
            if (!perm.granted) {
                results.push('   STOPPED: Permission not granted');
                Modal.alert('Test Results', results.join('\n'));
                return;
            }

            // Step 2: Project ID
            const projectId = Constants?.expoConfig?.extra?.eas?.projectId;
            results.push(`2. ProjectId: ${projectId || 'NOT FOUND'}`);
            if (!projectId) {
                results.push('   STOPPED: No projectId');
                Modal.alert('Test Results', results.join('\n'));
                return;
            }

            // Step 3: Get Expo push token
            try {
                const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
                const token = tokenData.data;
                setPushToken(token);
                results.push(`3. Expo token: ${token}`);

                // Step 4: Get FCM device token
                try {
                    const deviceToken = await Notifications.getDevicePushTokenAsync();
                    const fcmToken = typeof deviceToken.data === 'string' ? deviceToken.data : JSON.stringify(deviceToken.data);
                    results.push(`4. FCM token: ${fcmToken.substring(0, 50)}...`);
                } catch (e: any) {
                    results.push(`4. FCM token ERROR: ${e.message}`);
                }

                // Step 5: Register on server
                try {
                    await registerPushToken(auth.credentials, token);
                    results.push('5. Server registration: OK');
                } catch (e: any) {
                    results.push(`5. Server registration ERROR: ${e.message}`);
                }

                // Step 6: Verify on server
                try {
                    const serverResult = await fetchPushTokens(auth.credentials);
                    const found = serverResult.some((t: { token: string }) => t.token === token);
                    results.push(`6. Server verification: ${found ? 'Token FOUND' : 'Token NOT FOUND'} (${serverResult.length} total)`);
                } catch (e: any) {
                    results.push(`6. Server verification ERROR: ${e.message}`);
                }

                // Step 7: Local notification test
                try {
                    await Notifications.scheduleNotificationAsync({
                        content: {
                            title: 'Full Test - Local',
                            body: 'Local notification works!',
                            data: { test: true },
                        },
                        trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 1 },
                    });
                    results.push('7. Local notification: Scheduled');
                } catch (e: any) {
                    results.push(`7. Local notification ERROR: ${e.message}`);
                }

            } catch (e: any) {
                results.push(`3. Expo token ERROR: ${e.message}`);
                results.push('   This is likely the root cause. Check:');
                results.push('   - google-services.json has correct mobilesdk_app_id for this package');
                results.push('   - FCM credentials are configured in Expo dashboard');
                results.push('   - EAS project has this package registered');
            }

            Modal.alert('Full Test Results', results.join('\n'));
        } finally {
            setLoading(false);
            await runDiagnostics();
        }
    }, [auth.credentials, runDiagnostics]);

    const statusColor = (s: DiagnosticEntry['status']) => {
        switch (s) {
            case 'ok': return '#34C759';
            case 'warn': return '#FF9500';
            case 'error': return '#FF3B30';
            default: return '#8E8E93';
        }
    };

    const statusIcon = (s: DiagnosticEntry['status']): React.ComponentProps<typeof Ionicons>['name'] => {
        switch (s) {
            case 'ok': return 'checkmark-circle';
            case 'warn': return 'warning';
            case 'error': return 'close-circle';
            default: return 'information-circle';
        }
    };

    return (
        <ItemList>
            {/* Diagnostics */}
            <ItemGroup title="Diagnostics" footer="Auto-detected device and notification state.">
                {diagnostics.map((d, i) => (
                    <Item
                        key={i}
                        title={d.label}
                        subtitle={d.value}
                        subtitleLines={0}
                        icon={<Ionicons name={statusIcon(d.status)} size={22} color={statusColor(d.status)} />}
                        showChevron={false}
                        copy={d.value}
                    />
                ))}
                <Item
                    title="Re-run Diagnostics"
                    icon={<Ionicons name="refresh-outline" size={22} color="#007AFF" />}
                    onPress={runDiagnostics}
                />
            </ItemGroup>

            {/* Actions */}
            <ItemGroup title="Actions" footer="Step-by-step notification testing.">
                <Item
                    title="Request Permission"
                    subtitle={permissionInfo ? `Current: ${permissionInfo.status}` : 'Check and request notification permission'}
                    icon={<Ionicons name="shield-checkmark-outline" size={22} color="#34C759" />}
                    onPress={handleRequestPermission}
                    loading={loading}
                />
                <Item
                    title="Send Local Notification"
                    subtitle="Schedule a local notification in 2 seconds"
                    icon={<Ionicons name="notifications-outline" size={22} color="#FF9500" />}
                    onPress={handleLocalNotification}
                />
                <Item
                    title="Register Token on Server"
                    subtitle={pushToken ? `Current: ${pushToken.substring(0, 30)}...` : 'Get token and register on server'}
                    icon={<Ionicons name="cloud-upload-outline" size={22} color="#007AFF" />}
                    onPress={handleRegisterToken}
                    loading={loading}
                    disabled={!auth.credentials}
                />
                <Item
                    title="Fetch Server Tokens"
                    subtitle={`${serverTokens.length} tokens on server`}
                    icon={<Ionicons name="cloud-download-outline" size={22} color="#5856D6" />}
                    onPress={handleFetchServerTokens}
                    loading={loading}
                    disabled={!auth.credentials}
                />
                <Item
                    title="Full Round-Trip Test"
                    subtitle="Permission -> Token -> Register -> Verify -> Local notification"
                    icon={<Ionicons name="rocket-outline" size={22} color="#FF2D55" />}
                    onPress={handleFullTest}
                    loading={loading}
                    disabled={!auth.credentials}
                />
            </ItemGroup>

            {/* Current Token */}
            {pushToken && (
                <ItemGroup title="Current Expo Push Token" footer="Copy and use at https://expo.dev/notifications to send a test remote push.">
                    <Item
                        title={pushToken}
                        subtitleLines={0}
                        icon={<Ionicons name="key-outline" size={22} color="#FF9500" />}
                        onPress={() => handleCopyToken(pushToken)}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Server Tokens */}
            {serverTokens.length > 0 && (
                <ItemGroup title={`Server Tokens (${serverTokens.length})`}>
                    {serverTokens.map(t => (
                        <Item
                            key={t.id}
                            title={t.token.substring(0, 35) + '...'}
                            subtitle={`Registered: ${new Date(t.createdAt).toLocaleString()}`}
                            icon={<Ionicons name="server-outline" size={22} color="#8E8E93" />}
                            onPress={() => handleCopyToken(t.token)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
});
