<script setup lang="ts">
import { z } from "zod";
import { useChangePassword } from "~/composables/mutations/useAccountMutations";
import { AuthRequestError } from "~/lib/auth-client";

const toast = useToast();
const { mutateAsync: changePassword, isLoading: saving } = useChangePassword();

const schema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z.string().min(8, "At least 8 characters"),
    confirmPassword: z.string(),
  })
  // Confirmation is checked here rather than server-side because the server
  // never sees it: it exists to catch a typo in a field nobody can read back.
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "Both new password fields must match",
    path: ["confirmPassword"],
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    message: "Choose a password you have not used here before",
    path: ["newPassword"],
  });

const form = reactive({
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
  revokeOtherSessions: false,
});

function reset() {
  form.currentPassword = "";
  form.newPassword = "";
  form.confirmPassword = "";
  form.revokeOtherSessions = false;
}

/**
 * "Invalid password" is Better Auth's phrasing for every rejected credential,
 * which on this form reads as though the NEW one was refused. Only the current
 * one can be wrong here.
 */
function describe(err: unknown): string {
  if (err instanceof AuthRequestError && err.code === "INVALID_PASSWORD") {
    return "That is not your current password";
  }
  return err instanceof Error ? err.message : "Could not change your password";
}

async function handleSubmit() {
  const revoked = form.revokeOtherSessions;
  try {
    await changePassword({
      currentPassword: form.currentPassword,
      newPassword: form.newPassword,
      revokeOtherSessions: revoked,
    });
    reset();
    toast.add({
      title: "Password changed",
      description: revoked ? "Every other browser has been signed out." : undefined,
      color: "success",
    });
  } catch (err) {
    // Clear only the current-password field: retyping a new password you have
    // already chosen twice is busywork, and the wrong current password is the
    // overwhelmingly likely reason to be here.
    form.currentPassword = "";
    toast.add({ title: describe(err), color: "error" });
  }
}
</script>

<template>
  <UCard data-testid="account-password-card">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-lock" class="text-primary" />
        <h3 class="text-sm font-semibold">Password</h3>
      </div>
      <p class="text-xs text-muted mt-1">
        The password you sign in with. Readers and scripts use app passwords instead, on the
        Connections tab.
      </p>
    </template>

    <UForm :schema="schema" :state="form" class="space-y-4" @submit="handleSubmit">
      <UFormField name="currentPassword" label="Current password">
        <UInput
          v-model="form.currentPassword"
          type="password"
          autocomplete="current-password"
          class="w-full"
          data-testid="current-password-input"
        />
      </UFormField>

      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField name="newPassword" label="New password" help="At least 8 characters">
          <UInput
            v-model="form.newPassword"
            type="password"
            autocomplete="new-password"
            class="w-full"
            data-testid="new-password-input"
          />
        </UFormField>
        <UFormField name="confirmPassword" label="Confirm new password">
          <UInput
            v-model="form.confirmPassword"
            type="password"
            autocomplete="new-password"
            class="w-full"
            data-testid="confirm-password-input"
          />
        </UFormField>
      </div>

      <UCheckbox
        v-model="form.revokeOtherSessions"
        label="Sign out everywhere else"
        description="Ends every other signed-in browser. App passwords keep working — revoke those on the Connections tab."
        data-testid="revoke-others-checkbox"
      />

      <UButton
        type="submit"
        label="Change password"
        color="primary"
        :loading="saving"
        data-testid="change-password-btn"
      />
    </UForm>
  </UCard>
</template>
