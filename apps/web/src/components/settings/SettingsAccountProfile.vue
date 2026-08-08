<script setup lang="ts">
import { z } from "zod";
import { useUpdateProfile } from "~/composables/mutations/useAccountMutations";

const toast = useToast();
const { userName, userEmail } = useAuth();
const { mutateAsync: updateProfile, isLoading: saving } = useUpdateProfile();

const schema = z.object({
  name: z.string().min(1, "Enter a name").max(200, "Keep it under 200 characters"),
});
const form = reactive({ name: "" });

// The session arrives after the first render, so the field cannot simply be
// initialised from it. immediate covers the case where it is already there.
watch(userName, (name) => (form.name = name ?? ""), { immediate: true });

const unchanged = computed(() => form.name.trim() === (userName.value ?? ""));

async function handleSubmit() {
  try {
    await updateProfile({ name: form.name.trim() });
    toast.add({ title: "Name updated", color: "success" });
  } catch (err) {
    toast.add({
      title: err instanceof Error ? err.message : "Could not update your name",
      color: "error",
    });
  }
}
</script>

<template>
  <UCard data-testid="account-profile-card">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-user-round" class="text-primary" />
        <h3 class="text-sm font-semibold">Profile</h3>
      </div>
      <p class="text-xs text-muted mt-1">How you appear in this install.</p>
    </template>

    <UForm :schema="schema" :state="form" class="space-y-4" @submit="handleSubmit">
      <UFormField name="name" label="Display name">
        <UInput v-model="form.name" class="w-full" data-testid="profile-name-input" />
      </UFormField>

      <UFormField
        label="Email"
        help="Your email is also your sign-in name, and it cannot be changed here. Ask an admin to create a new account if you need a different address."
      >
        <!-- readonly, not disabled: a disabled input cannot be focused or its
             text selected, and copying your own address is the main thing
             anyone does with this field. -->
        <UInput
          :model-value="userEmail ?? ''"
          readonly
          class="w-full"
          :ui="{ base: 'text-muted' }"
          data-testid="profile-email-input"
        />
      </UFormField>

      <UButton
        type="submit"
        label="Save name"
        color="primary"
        :loading="saving"
        :disabled="unchanged"
        data-testid="save-profile-btn"
      />
    </UForm>
  </UCard>
</template>
