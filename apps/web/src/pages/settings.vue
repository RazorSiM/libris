<script setup lang="ts">
import { z } from "zod";
import { useQueryCache } from "@pinia/colada";
import { useClipboard } from "@vueuse/core";

useDashboard();

useHead({
  title: "Settings",
});

const { isAuthenticated, isAdmin, userLabel, setAuthenticated, login, logout } = useAuth();
const toast = useToast();
const queryCache = useQueryCache();
const { mutateAsync: runSetupMutation, isLoading: settingsLoading } = useSetup();
const { copy, copied: keyCopied } = useClipboard();
const route = useRoute();
const router = useRouter();

const DEFAULT_TAB = "connections";

// --- Tabs ---
const tabs = computed(() => {
  const items = [
    { label: "Connections", value: "connections", slot: "connections", icon: "i-lucide-plug" },
  ];

  if (isAdmin.value) {
    items.push(
      { label: "API Keys", value: "api-keys", slot: "api-keys", icon: "i-lucide-key-round" },
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

// --- Form schemas ---
const setupSchema = z.object({
  label: z.string().min(1, "Label is required").max(50, "Max 50 characters"),
});

const loginSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
});

// --- Auth forms ---
const setupState = reactive({ label: "Web UI" });
const loginState = reactive({ apiKey: "" });
const loginLoading = ref(false);
const revealedKey = ref<string | null>(null);

async function runSetup() {
  try {
    const result = await runSetupMutation(setupState.label);
    await setAuthenticated(true);
    revealedKey.value = result.key;
    refreshAll();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Setup failed";
    toast.add({ title: message, color: "error" });
  }
}

function copyRevealedKey() {
  if (!revealedKey.value) return;
  copy(revealedKey.value);
  toast.add({ title: "API key copied to clipboard", color: "success" });
}

function dismissRevealedKey() {
  revealedKey.value = null;
}

async function handleLogin() {
  loginLoading.value = true;
  try {
    await login(loginState.apiKey);
    loginState.apiKey = "";
    toast.add({ title: "Logged in", color: "success" });
    refreshAll();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid API key";
    toast.add({ title: message, color: "error" });
  } finally {
    loginLoading.value = false;
  }
}

async function handleLogout() {
  await logout();
  toast.add({ title: "Logged out", color: "neutral" });
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
        <!-- API Key Reveal Modal -->
        <UModal :open="!!revealedKey" @update:open="!$event && dismissRevealedKey()">
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-shield-check" class="text-success text-lg" />
              <h3 class="text-lg font-semibold" data-testid="key-reveal-title">Setup Complete</h3>
            </div>
          </template>

          <template #body>
            <div class="space-y-4">
              <div class="rounded-md border border-warning/30 bg-warning/5 p-3">
                <div class="flex items-start gap-2">
                  <UIcon name="i-lucide-triangle-alert" class="text-warning mt-0.5 shrink-0" />
                  <p class="text-sm text-warning">
                    This is your only chance to copy this key. It cannot be retrieved later.
                  </p>
                </div>
              </div>

              <div>
                <label class="text-xs font-medium text-muted mb-1 block">Your API Key</label>
                <div class="flex items-center gap-2">
                  <code
                    class="flex-1 rounded-md border border-default bg-elevated px-3 py-2 text-sm font-mono select-all break-all"
                    data-testid="revealed-api-key"
                  >
                    {{ revealedKey }}
                  </code>
                  <UButton
                    :icon="keyCopied ? 'i-lucide-check' : 'i-lucide-copy'"
                    :color="keyCopied ? 'success' : 'neutral'"
                    aria-label="Copy API key"
                    variant="outline"
                    size="md"
                    data-testid="copy-key-btn"
                    @click="copyRevealedKey"
                  />
                </div>
              </div>
            </div>
          </template>

          <template #footer>
            <div class="flex justify-end">
              <UButton
                label="I've saved my key"
                color="primary"
                data-testid="dismiss-key-btn"
                @click="dismissRevealedKey"
              />
            </div>
          </template>
        </UModal>

        <!-- Login / Setup (unauthenticated) -->
        <div v-if="!isAuthenticated" class="rounded-lg border border-default p-6 space-y-4">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-key-round" class="text-xl text-primary" />
            <h2 class="text-lg font-semibold">Welcome to Libris — Set Up Your API Key</h2>
          </div>
          <p class="text-sm text-muted">
            No API key configured. If this is a fresh install, run initial setup to generate one.
            Otherwise, paste an existing key below.
          </p>

          <div class="space-y-3 rounded-md bg-elevated/50 p-4">
            <h3 class="text-sm font-medium">Initial Setup</h3>
            <p class="text-xs text-muted">
              Creates the first API key for this server. Only works once.
            </p>
            <UForm :schema="setupSchema" :state="setupState" @submit="runSetup">
              <div class="flex items-end gap-2">
                <UFormField name="label" label="Key Label" class="flex-1">
                  <UInput
                    v-model="setupState.label"
                    placeholder="e.g. Web UI"
                    class="w-full"
                    data-testid="field-key-label"
                  />
                </UFormField>
                <UButton
                  type="submit"
                  label="Run Setup"
                  color="primary"
                  icon="i-lucide-zap"
                  :loading="settingsLoading"
                  data-testid="run-setup-btn"
                />
              </div>
            </UForm>
          </div>

          <div class="relative flex items-center py-2">
            <div class="flex-1 border-t border-default" />
            <span class="px-3 text-xs text-muted">or enter existing key</span>
            <div class="flex-1 border-t border-default" />
          </div>

          <UForm :schema="loginSchema" :state="loginState" @submit="handleLogin">
            <div class="space-y-3">
              <UFormField name="apiKey" label="API Key">
                <UInput
                  v-model="loginState.apiKey"
                  type="password"
                  placeholder="Enter your API key"
                  class="w-full"
                  data-testid="field-api-key"
                />
              </UFormField>
              <UButton
                type="submit"
                label="Login"
                color="primary"
                :loading="loginLoading"
                data-testid="login-btn"
              />
            </div>
          </UForm>
        </div>

        <!-- Tabbed settings (when authenticated) -->
        <UTabs v-else v-model="selectedTab" :items="tabs" value-key="value" class="w-full">
          <template #connections>
            <SettingsConnections />
          </template>

          <template v-if="isAdmin" #api-keys>
            <SettingsApiKeys />
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
