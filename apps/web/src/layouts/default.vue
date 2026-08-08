<script setup lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";
import logoHorizontal from "~/assets/logo-horizontal.svg";
import logoIcon from "~/assets/logo-icon.svg";

const open = ref(false);
const { userLabel, isAdmin } = useAuth();
const { showShortcuts } = useDashboard();
const { docsUrl } = useLibrisConfig();

// Sidebar data — Pinia Colada queries (enabled when authenticated)
const { data: inboxCountData } = useInboxCountQuery();
const { data: failedJobsCountData } = useFailedJobsCountQuery();
const { data: readingCountsData } = useReadingCountsQuery();

const mainLinks = computed<NavigationMenuItem[]>(() => [
  {
    label: "Home",
    icon: "i-lucide-house",
    to: "/",
    kbds: ["G", "H"],
    onSelect: () => {
      open.value = false;
    },
  },
  {
    label: "Inbox",
    icon: "i-lucide-inbox",
    to: "/inbox",
    kbds: ["G", "I"],
    badge: inboxCountData.value?.count
      ? {
          label: String(inboxCountData.value.count),
          color: "info" as const,
          variant: "subtle" as const,
          size: "sm" as const,
        }
      : undefined,
    onSelect: () => {
      open.value = false;
    },
  },
  {
    label: "Library",
    icon: "i-lucide-library",
    to: "/library",
    kbds: ["G", "L"],
    onSelect: () => {
      open.value = false;
    },
  },
  {
    label: "Series",
    icon: "i-lucide-library-big",
    to: "/series",
    onSelect: () => {
      open.value = false;
    },
  },
  {
    label: "Stats",
    icon: "i-lucide-bar-chart-3",
    to: "/stats",
    onSelect: () => {
      open.value = false;
    },
  },
]);

function readingBadge(count: number) {
  return count
    ? {
        label: String(count),
        color: "neutral" as const,
        variant: "subtle" as const,
        size: "sm" as const,
      }
    : undefined;
}

const readingLinks = computed<NavigationMenuItem[]>(() => [
  {
    label: "Reading",
    icon: "i-lucide-book-open",
    to: "/reading/reading",
    badge: readingBadge(readingCountsData.value?.reading ?? 0),
    onSelect: () => {
      open.value = false;
    },
  },
  {
    label: "Finished",
    icon: "i-lucide-check-circle",
    to: "/reading/finished",
    badge: readingBadge(readingCountsData.value?.finished ?? 0),
    onSelect: () => {
      open.value = false;
    },
  },
  {
    label: "Unread",
    icon: "i-lucide-book",
    to: "/reading/unread",
    badge: readingBadge(readingCountsData.value?.unread ?? 0),
    onSelect: () => {
      open.value = false;
    },
  },
  {
    label: "Paused",
    icon: "i-lucide-pause-circle",
    to: "/reading/paused",
    badge: readingBadge(readingCountsData.value?.paused ?? 0),
    onSelect: () => {
      open.value = false;
    },
  },
]);

const settingsLinks = computed<NavigationMenuItem[]>(() => [
  {
    label: "Settings",
    icon: "i-lucide-settings",
    to: "/settings",
    kbds: ["G", "S"],
    badge: failedJobsCountData.value?.total
      ? {
          label: String(failedJobsCountData.value.total),
          color: "error" as const,
          variant: "subtle" as const,
          size: "sm" as const,
        }
      : undefined,
    onSelect: () => {
      open.value = false;
    },
  },
]);

// Book search — Pinia Colada query, debounced and keyed on the typed term.
const {
  term: searchTerm,
  results: searchResults,
  loading: searchLoading,
} = useSearchSuggestQuery();

const router = useRouter();

const bookItems = computed(() =>
  searchResults.value.map((book) => ({
    label: book.title ?? "Untitled",
    suffix: book.author ?? undefined,
    icon: book.status === "organized" ? "i-lucide-library" : "i-lucide-inbox",
    onSelect: () => {
      const path = book.status === "organized" ? `/library/${book.id}` : `/inbox/${book.id}`;
      router.push(path);
      open.value = false;
    },
  })),
);

const groups = computed(() => {
  const result: {
    id: string;
    label: string;
    items: Record<string, unknown>[];
    ignoreFilter?: boolean;
  }[] = [
    {
      id: "links",
      label: "Go to",
      items: [...mainLinks.value, ...readingLinks.value, ...settingsLinks.value],
    },
  ];

  if (searchTerm.value.trim()) {
    result.unshift({
      id: "books",
      label: "Books",
      items: bookItems.value,
      ignoreFilter: true,
    });
  }

  return result;
});
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      v-model:open="open"
      collapsible
      resizable
      class="bg-elevated/25"
    >
      <template #default="{ collapsed }">
        <div
          class="flex items-center gap-2"
          :class="collapsed ? 'justify-center py-2' : 'px-3 py-3'"
        >
          <img v-if="!collapsed" :src="logoHorizontal" alt="Libris" class="h-6 dark:invert" />
          <img v-else :src="logoIcon" alt="Libris" class="h-8 dark:invert" />
        </div>

        <UDashboardSearchButton :collapsed="collapsed" class="bg-transparent ring-default" />

        <UNavigationMenu :collapsed="collapsed" :items="mainLinks" orientation="vertical" tooltip />

        <!-- Reading section -->
        <div class="mt-3" data-testid="sidebar-reading">
          <div v-if="!collapsed" class="px-3 mb-1">
            <span class="text-xs font-medium text-muted uppercase tracking-wider"> Reading </span>
          </div>
          <UNavigationMenu
            :collapsed="collapsed"
            :items="readingLinks"
            orientation="vertical"
            tooltip
          />
        </div>

        <div class="mt-auto" />

        <!-- User label: also the way into the account settings, since your own
             name is where people look for "change my password". -->
        <ULink
          v-if="userLabel && !collapsed"
          to="/settings?tab=account"
          data-testid="sidebar-user-label"
          class="px-3 py-2 flex items-center gap-2 text-sm text-muted rounded-md hover:text-default hover:bg-elevated/50"
        >
          <UIcon name="i-lucide-user" class="shrink-0" />
          <span class="truncate">{{ userLabel }}</span>
          <UBadge v-if="isAdmin" variant="subtle" color="warning" size="xs">Admin</UBadge>
        </ULink>
        <UTooltip v-else-if="userLabel && collapsed" :text="userLabel">
          <ULink
            to="/settings?tab=account"
            data-testid="sidebar-user-label-collapsed"
            class="flex justify-center py-2 text-muted hover:text-default"
          >
            <UIcon name="i-lucide-user" />
          </ULink>
        </UTooltip>

        <UNavigationMenu
          v-if="docsUrl"
          :collapsed="collapsed"
          :items="[
            {
              label: 'Documentation',
              icon: 'i-lucide-book-open-text',
              to: docsUrl,
              target: '_blank',
            },
          ]"
          orientation="vertical"
          tooltip
          data-testid="sidebar-docs-link"
        />
        <UNavigationMenu
          :collapsed="collapsed"
          :items="settingsLinks"
          orientation="vertical"
          tooltip
        />
      </template>
    </UDashboardSidebar>

    <UDashboardSearch
      v-model:search-term="searchTerm"
      :groups="groups"
      :loading="searchLoading"
      title="Search"
      description="Jump to a page or search your library"
      data-testid="command-palette"
    />

    <slot />

    <KeyboardShortcutsModal v-model="showShortcuts" />
  </UDashboardGroup>
</template>
