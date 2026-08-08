<script setup lang="ts">
import {
  useRevokeOtherSessions,
  useRevokeSession,
  useSessionsQuery,
  type DeviceSession,
} from "~/composables/mutations/useSessionMutations";
import { formatTimeAgo } from "~/utils/formatters";
import { describeUserAgent, userAgentIcon } from "~/utils/user-agent";

const toast = useToast();
const router = useRouter();
const { logout } = useAuth();

const { data: sessions, status, refetch } = useSessionsQuery();
const { mutateAsync: revokeSession } = useRevokeSession();
const { mutateAsync: revokeOthers, isLoading: revokingOthers } = useRevokeOtherSessions();

/** The row awaiting confirmation, or null. */
const pendingRevoke = ref<DeviceSession | null>(null);
const confirmingSignOutEverywhere = ref(false);
const revokingId = ref<string | null>(null);

const others = computed(() => (sessions.value ?? []).filter((s) => !s.isCurrent));

function report(err: unknown, fallback: string) {
  toast.add({ title: err instanceof Error ? err.message : fallback, color: "error" });
}

async function confirmRevoke() {
  const target = pendingRevoke.value;
  pendingRevoke.value = null;
  if (!target) return;

  // Revoking your own session is a sign-out, and going through logout() rather
  // than revokeSession is what clears the query cache and the auth store too.
  // Left to revokeSession alone, the app would sit on a dead cookie rendering
  // one user's data until the next navigation discovered it.
  if (target.isCurrent) {
    await logout();
    toast.add({ title: "Signed out", color: "neutral" });
    await router.replace("/login");
    return;
  }

  revokingId.value = target.id;
  try {
    await revokeSession(target.token);
    toast.add({ title: `${describeUserAgent(target.userAgent)} signed out`, color: "success" });
  } catch (err) {
    report(err, "Could not sign that device out");
  } finally {
    revokingId.value = null;
  }
}

async function confirmSignOutEverywhere() {
  confirmingSignOutEverywhere.value = false;
  try {
    await revokeOthers();
    toast.add({ title: "Every other device signed out", color: "success" });
  } catch (err) {
    report(err, "Could not sign the other devices out");
  }
}
</script>

<template>
  <UCard data-testid="account-sessions-card">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-monitor-smartphone" class="text-primary" />
        <h3 class="text-sm font-semibold">Where you are signed in</h3>
        <UButton
          icon="i-lucide-refresh-cw"
          aria-label="Refresh the device list"
          variant="ghost"
          color="neutral"
          size="xs"
          class="ml-auto"
          data-testid="refresh-sessions-btn"
          @click="refetch()"
        />
      </div>
      <p class="text-xs text-muted mt-1">
        One entry per browser you have signed in with. Readers and scripts are not here — they use
        app passwords, on the Connections tab.
      </p>
    </template>

    <div v-if="status === 'pending'" class="space-y-2">
      <USkeleton v-for="i in 2" :key="i" class="h-16 w-full rounded-lg" />
    </div>

    <!-- An error must not fall through to the empty state. "No devices" and
         "we could not ask" mean opposite things here: the first says you are
         signed in nowhere else, and believing that when it is not true is the
         whole failure this page exists to prevent. -->
    <UAlert
      v-else-if="status === 'error'"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Could not load your devices"
      description="This list may be incomplete. Try again."
      data-testid="sessions-error"
    >
      <template #actions>
        <UButton label="Try again" color="error" variant="outline" size="xs" @click="refetch()" />
      </template>
    </UAlert>

    <div v-else-if="sessions?.length" class="space-y-2">
      <div
        v-for="session in sessions"
        :key="session.id"
        :data-testid="`session-item-${session.id}`"
        class="flex items-center gap-3 p-3 rounded-lg bg-elevated"
      >
        <UIcon :name="userAgentIcon(session.userAgent)" class="text-muted shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-highlighted">
              {{ describeUserAgent(session.userAgent) }}
            </span>
            <UBadge
              v-if="session.isCurrent"
              variant="subtle"
              color="primary"
              size="xs"
              data-testid="current-session-badge"
            >
              This browser
            </UBadge>
          </div>
          <div class="flex items-center gap-2 text-xs text-dimmed mt-0.5">
            <span>Signed in {{ formatTimeAgo(String(session.createdAt)) }}</span>
            <span v-if="session.ipAddress">&middot; {{ session.ipAddress }}</span>
            <span>&middot; expires {{ formatTimeAgo(String(session.expiresAt)) }}</span>
          </div>
        </div>
        <UButton
          label="Sign out"
          variant="ghost"
          color="error"
          size="sm"
          :loading="revokingId === session.id"
          :data-testid="`revoke-session-btn-${session.id}`"
          @click="pendingRevoke = session"
        />
      </div>
    </div>

    <p v-else class="text-sm text-muted" data-testid="no-sessions">
      No other devices. This browser is the only one signed in.
    </p>

    <template v-if="others.length" #footer>
      <UButton
        label="Sign out everywhere else"
        icon="i-lucide-log-out"
        variant="outline"
        color="error"
        size="sm"
        :loading="revokingOthers"
        data-testid="sign-out-others-btn"
        @click="confirmingSignOutEverywhere = true"
      />
    </template>
  </UCard>

  <UModal
    :open="!!pendingRevoke"
    :title="pendingRevoke?.isCurrent ? 'Sign out of this browser?' : 'Sign out that device?'"
    :description="
      pendingRevoke?.isCurrent
        ? 'This is the browser you are using now. You will be returned to the sign-in page.'
        : `${describeUserAgent(pendingRevoke?.userAgent)} will have to sign in again. App passwords are not affected.`
    "
    @update:open="
      (open: boolean) => {
        if (!open) pendingRevoke = null;
      }
    "
  >
    <template #footer>
      <div class="flex gap-2 justify-end">
        <UButton
          label="Cancel"
          variant="ghost"
          data-testid="cancel-revoke-session-btn"
          @click="pendingRevoke = null"
        />
        <UButton
          label="Sign out"
          color="error"
          data-testid="confirm-revoke-session-btn"
          @click="confirmRevoke"
        />
      </div>
    </template>
  </UModal>

  <UModal
    :open="confirmingSignOutEverywhere"
    title="Sign out everywhere else?"
    description="Every browser except this one will have to sign in again. App passwords keep working — revoke those on the Connections tab."
    @update:open="
      (open: boolean) => {
        if (!open) confirmingSignOutEverywhere = false;
      }
    "
  >
    <template #footer>
      <div class="flex gap-2 justify-end">
        <UButton
          label="Cancel"
          variant="ghost"
          data-testid="cancel-sign-out-others-btn"
          @click="confirmingSignOutEverywhere = false"
        />
        <UButton
          label="Sign out everywhere else"
          color="error"
          data-testid="confirm-sign-out-others-btn"
          @click="confirmSignOutEverywhere"
        />
      </div>
    </template>
  </UModal>
</template>
