<script setup lang="ts">
import { z } from "zod";
import { useQueryCache } from "@pinia/colada";
import { useClipboard } from "@vueuse/core";

useDashboard();

useHead({
  title: "Settings",
});

const { isAuthenticated, isAdmin, userLabel, logout } = useAuth();
const toast = useToast();
const queryCache = useQueryCache();
const { copy, copied: keyCopied } = useClipboard();
const route = useRoute();
const router = useRouter();

const DEFAULT_TAB = "connections";

// --- Tabs ---
const tabs = computed(() => {
  const items = [
    { label: "Connections", value: "connections", slot: "connections", icon: "i-lucide-plug" },
    { label: "Account", value: "account", slot: "account", icon: "i-lucide-user-round" },
  ];

  if (isAdmin.value) {
    items.push(
      { label: "Users", value: "users", slot: "users", icon: "i-lucide-users" },
      { label: "System", value: "system", slot: "system", icon: "i-lucide-activity" },
      {
        label: "Jobs",
        value: "jobs",
        slot: "jobs",
        icon: "i-lucide-list",
      },
      {
        label: "Failed Jobs",
        value: "failed-jobs",
        slot: "failed-jobs",
        icon: "i-lucide-alert-triangle",
      },
      {
        label: "Queues",
        value: "queues",
        slot: "queues",
        icon: "i-lucide-layers",
      },
      { label: "Paths", value: "paths", slot: "paths", icon: "i-lucide-folder-open" },
    );
  }

  return items;
});

function getTabQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

const availableTabValues = computed(() => new Set(tabs.value.map((tab) => tab.value)));

const normalizedTab = computed(() => {
  const requested = getTabQueryValue(route.query.tab);
  if (requested && availableTabValues.value.has(requested)) {
    return requested;
  }

  return DEFAULT_TAB;
});

async function syncTabQuery(nextTab: string): Promise<void> {
  const nextQuery = { ...route.query };

  if (nextTab === DEFAULT_TAB) {
    delete nextQuery.tab;
  } else {
    nextQuery.tab = nextTab;
  }

  await router.replace({ query: nextQuery });
}

const selectedTab = computed({
  get: () => normalizedTab.value,
  set: (value: string) => {
    const nextTab = availableTabValues.value.has(value) ? value : DEFAULT_TAB;
    void syncTabQuery(nextTab);
  },
});

watch(
  [isAuthenticated, normalizedTab, () => route.query.tab],
  ([authenticated, tab]) => {
    if (!authenticated) return;

    const requested = getTabQueryValue(route.query.tab);
    const expected = tab === DEFAULT_TAB ? undefined : tab;

    if (requested === expected) return;

    void syncTabQuery(tab);
  },
  { immediate: true },
);

async function handleLogout() {
  await logout();
  toast.add({ title: "Logged out", color: "neutral" });
  // Navigate explicitly: the router guard only runs on navigation, so without
  // this a signed-out user sits on the settings tabs watching every query fail.
  await router.replace("/login");
}

const { refetch: refetchSettingsStatus } = useSettingsStatusQuery();

function refreshAll() {
  if (isAuthenticated.value) {
    refetchSettingsStatus();
    queryCache.invalidateQueries({ key: ["settings", "hardcover-status"] });
  }
}

// WebSocket: listen for real-time job updates — registers once when auth becomes true
const { on } = useServerEvents();

whenever(
  isAuthenticated,
  () => {
    on("job:failed", () => {
      queryCache.invalidateQueries({ key: ["settings", "status"] });
    });

    const jobEventTypes = ["book:detected", "book:parsed", "book:metadata-ready", "book:organized"];
    for (const type of jobEventTypes) {
      on(type, () => {
        queryCache.invalidateQueries({ key: ["settings", "status"] });
      });
    }
  },
  { immediate: true, once: true },
);
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Settings">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <div class="flex items-center gap-2">
            <UBadge
              v-if="isAuthenticated && userLabel"
              data-testid="user-label-badge"
              variant="subtle"
              color="neutral"
              size="sm"
            >
              <UIcon name="i-lucide-user" class="mr-1" />
              {{ userLabel }}
            </UBadge>
            <UButton
              v-if="isAuthenticated"
              icon="i-lucide-refresh-cw"
              aria-label="Refresh"
              variant="ghost"
              color="neutral"
              data-testid="refresh-btn"
              @click="refreshAll"
            />
            <UButton
              v-if="isAuthenticated"
              label="Logout"
              icon="i-lucide-log-out"
              variant="ghost"
              color="neutral"
              data-testid="logout-btn"
              @click="handleLogout"
            />
            <ColorModeToggle />
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-4xl mx-auto py-8 px-4">
        <!--
          There is no sign-in form here: the router guard sends unauthenticated
          visitors to /login, which also handles first-run setup. Reaching this
          page at all means there is a session.
        -->
        <UTabs v-model="selectedTab" :items="tabs" value-key="value" class="w-full">
          <template #connections>
            <SettingsConnections />
          </template>

          <template #account>
            <SettingsAccount />
          </template>

          <template v-if="isAdmin" #users>
            <SettingsUsers />
          </template>

          <template v-if="isAdmin" #system>
            <SettingsSystem @retry="refreshAll" />
          </template>

          <template v-if="isAdmin" #jobs>
            <SettingsJobsBrowser />
          </template>

          <template v-if="isAdmin" #failed-jobs>
            <SettingsFailedJobs @retry="refreshAll" />
          </template>

          <template v-if="isAdmin" #queues>
            <SettingsQueueManagement @retry="refreshAll" />
          </template>

          <template v-if="isAdmin" #paths>
            <SettingsPaths @retry="refreshAll" />
          </template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>
</template>
