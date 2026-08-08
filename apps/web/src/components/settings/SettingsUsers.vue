<script setup lang="ts">
import { z } from "zod";
import {
  useBanUser,
  useCreateUser,
  useSetUserPassword,
  useSetUserRole,
  useUsersQuery,
  type ManagedUser,
} from "~/composables/mutations/useUserMutations";

/**
 * Household account management.
 *
 * Self-registration is disabled, so this page is the only way a second person
 * gets an account — without it, adding someone means SQL. It is also the only
 * password-recovery path, since there is no mail transport.
 */

const toast = useToast();
const { userId: currentUserId, refresh: refreshSession } = useAuth();

const { data: users, status: usersStatus } = useUsersQuery();
const { mutateAsync: createUser, isLoading: creating } = useCreateUser();
const { mutateAsync: setRole } = useSetUserRole();
const { mutateAsync: setBanned } = useBanUser();
const { mutateAsync: setPassword, isLoading: settingPassword } = useSetUserPassword();

const createSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.email("Enter a valid email address"),
  password: z.string().min(8, "At least 8 characters").max(128),
});
const createForm = reactive({
  name: "",
  email: "",
  password: "",
  role: "user" as "user" | "admin",
});

const passwordTarget = ref<ManagedUser | null>(null);
const newPassword = ref("");

/**
 * The last admin cannot be demoted or banned.
 *
 * Otherwise one click locks everybody out of user management permanently, and
 * the only way back is SQL — the exact situation this page exists to avoid.
 */
const adminCount = computed(() => (users.value ?? []).filter((u) => u.role === "admin").length);
function isLastAdmin(user: ManagedUser): boolean {
  return user.role === "admin" && adminCount.value <= 1;
}
function isSelf(user: ManagedUser): boolean {
  return user.id === currentUserId.value;
}

function report(err: unknown, fallback: string) {
  toast.add({ title: err instanceof Error ? err.message : fallback, color: "error" });
}

async function handleCreate() {
  try {
    await createUser({ ...createForm });
    toast.add({ title: `Account created for ${createForm.email}`, color: "success" });
    createForm.name = "";
    createForm.email = "";
    createForm.password = "";
    createForm.role = "user";
  } catch (err) {
    report(err, "Could not create the account");
  }
}

async function toggleRole(user: ManagedUser) {
  const role = user.role === "admin" ? "user" : "admin";
  try {
    await setRole({ userId: user.id, role });
    toast.add({ title: `${user.name} is now ${role}`, color: "success" });
    // Demoting yourself changes what YOU are allowed to see. Better Auth
    // refreshes the affected session server-side immediately, so without
    // re-reading it the store keeps isAdmin true, this very panel keeps
    // rendering, and its queries start 403ing. Re-reading also drops the admin
    // tabs, which sends the page back to the default tab on its own.
    if (isSelf(user)) await refreshSession();
  } catch (err) {
    report(err, "Could not change the role");
  }
}

async function toggleBan(user: ManagedUser) {
  const ban = !user.banned;
  try {
    await setBanned({ userId: user.id, ban });
    toast.add({
      title: ban ? `${user.name} is banned` : `${user.name} is unbanned`,
      color: "success",
    });
  } catch (err) {
    report(err, "Could not change the ban");
  }
}

async function handleSetPassword() {
  const user = passwordTarget.value;
  if (!user) return;
  // The button is disabled for your own row; this is the second lock, because
  // the consequence of getting here is signing yourself out mid-action.
  if (isSelf(user)) {
    passwordTarget.value = null;
    toast.add({ title: "Change your own password on the Account tab", color: "warning" });
    return;
  }
  try {
    await setPassword({ userId: user.id, newPassword: newPassword.value });
    toast.add({
      title: `Password set for ${user.name}. Their browser sessions were signed out.`,
      color: "success",
    });
    passwordTarget.value = null;
    newPassword.value = "";
  } catch (err) {
    report(err, "Could not set the password");
  }
}
</script>

<template>
  <div class="space-y-6 pt-6" data-testid="users-panel">
    <div>
      <h2 class="text-lg font-semibold">Users</h2>
      <p class="text-sm text-muted mt-1">
        Accounts are created here. There is no self-registration, and no password-reset email — set
        a password for someone and tell them out of band.
      </p>
    </div>

    <UCard>
      <template #header>
        <h3 class="text-sm font-semibold">Add someone</h3>
      </template>
      <UForm :schema="createSchema" :state="createForm" class="space-y-3" @submit="handleCreate">
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField name="name" label="Name">
            <UInput v-model="createForm.name" class="w-full" data-testid="new-user-name" />
          </UFormField>
          <UFormField name="email" label="Email">
            <UInput
              v-model="createForm.email"
              type="email"
              class="w-full"
              data-testid="new-user-email"
            />
          </UFormField>
          <UFormField name="password" label="Initial password" hint="At least 8 characters">
            <UInput
              v-model="createForm.password"
              type="password"
              class="w-full"
              data-testid="new-user-password"
            />
          </UFormField>
          <UFormField name="role" label="Role">
            <USelect
              v-model="createForm.role"
              :items="[
                { label: 'User', value: 'user' },
                { label: 'Admin', value: 'admin' },
              ]"
              class="w-full"
              data-testid="new-user-role"
            />
          </UFormField>
        </div>
        <UButton
          type="submit"
          label="Create account"
          icon="i-lucide-user-plus"
          color="primary"
          :loading="creating"
          data-testid="create-user-btn"
        />
      </UForm>
    </UCard>

    <div v-if="usersStatus === 'pending'" class="space-y-2">
      <USkeleton v-for="i in 3" :key="i" class="h-16 w-full rounded-lg" />
    </div>
    <div v-else class="space-y-2">
      <div
        v-for="user in users"
        :key="user.id"
        :data-testid="`user-item-${user.id}`"
        class="flex items-center gap-3 p-3 rounded-lg bg-elevated"
      >
        <UIcon name="i-lucide-user" class="text-muted shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-highlighted">{{ user.name }}</span>
            <UBadge
              v-if="user.role === 'admin'"
              variant="subtle"
              color="warning"
              size="xs"
              data-testid="role-badge-admin"
            >
              Admin
            </UBadge>
            <UBadge v-if="user.banned" variant="subtle" color="error" size="xs">Banned</UBadge>
          </div>
          <div class="text-xs text-dimmed mt-0.5">{{ user.email }}</div>
        </div>

        <UButton
          :label="user.role === 'admin' ? 'Make user' : 'Make admin'"
          variant="ghost"
          size="sm"
          :disabled="isLastAdmin(user)"
          :title="isLastAdmin(user) ? 'The last admin cannot be demoted' : undefined"
          :data-testid="`toggle-role-btn-${user.id}`"
          @click="toggleRole(user)"
        />
        <UButton
          :label="user.banned ? 'Unban' : 'Ban'"
          variant="ghost"
          size="sm"
          :color="user.banned ? 'neutral' : 'error'"
          :disabled="isSelf(user) || isLastAdmin(user)"
          :title="isSelf(user) ? 'You cannot ban yourself' : undefined"
          :data-testid="`toggle-ban-btn-${user.id}`"
          @click="toggleBan(user)"
        />
        <!-- Not on your own row. The server deletes every session belonging to
             the target, so pointing this at yourself destroys the cookie in the
             tab you are using — and the Account tab is where you change your
             own password anyway, with the current-password check that belongs
             on it. -->
        <UButton
          label="Set password"
          variant="ghost"
          size="sm"
          :disabled="isSelf(user)"
          :title="isSelf(user) ? 'Change your own password on the Account tab' : undefined"
          :data-testid="`set-password-btn-${user.id}`"
          @click="passwordTarget = user"
        />
      </div>
    </div>
  </div>

  <UModal
    :open="!!passwordTarget"
    :title="`Set a password for ${passwordTarget?.name ?? ''}`"
    description="All of their browser sessions will be signed out. App passwords for readers stay active. Pass the new password to them yourself."
    @update:open="
      (v: boolean) => {
        if (!v) passwordTarget = null;
      }
    "
  >
    <template #body>
      <UInput
        v-model="newPassword"
        type="password"
        placeholder="At least 8 characters"
        class="w-full"
        data-testid="set-password-input"
      />
    </template>
    <template #footer>
      <div class="flex gap-2 justify-end">
        <UButton
          label="Cancel"
          variant="ghost"
          data-testid="cancel-set-password-btn"
          @click="passwordTarget = null"
        />
        <UButton
          label="Set password"
          color="primary"
          :loading="settingPassword"
          :disabled="newPassword.length < 8"
          data-testid="confirm-set-password-btn"
          @click="handleSetPassword"
        />
      </div>
    </template>
  </UModal>
</template>
