import type { Router } from "expo-router"
import { useRouter } from "expo-router"
import { storage } from '@/sync/storage';
import { trackSessionSwitched } from '@/track';

/**
 * Navigate to a session screen.
 *
 * Uses plain router.navigate() — the Stack navigator pushes the session on top
 * of index when it doesn't exist, or pops to it when it does.
 *
 * dangerouslySingular was removed because it caused the Stack to lose the index
 * screen on Android (back from session exited the app).
 */
export function navigateToSession(router: Router, sessionId: string) {
    const session = storage.getState().sessions[sessionId];
    if (session) {
        trackSessionSwitched(session);
    }

    router.navigate(`/session/${encodeURIComponent(sessionId)}`);
}

export function useNavigateToSession() {
    const router = useRouter();
    return (sessionId: string) => {
        navigateToSession(router, sessionId);
    }
}
