<script setup lang="ts">
const { isAdmin } = useAuth();
</script>

<template>
  <div class="space-y-6 pt-6" data-testid="account-panel">
    <div>
      <h2 class="text-lg font-semibold">Account</h2>
      <p class="text-sm text-muted mt-1">Your name and the password you sign in with.</p>
    </div>

    <SettingsAccountProfile />
    <SettingsAccountPassword />

    <p v-if="!isAdmin" class="text-sm text-muted" data-testid="account-recovery-note">
      Forgotten your password? There is no reset email — ask an admin to set a new one for you.
    </p>
  </div>
</template>
