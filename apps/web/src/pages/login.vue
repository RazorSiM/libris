<script setup lang="ts">
import { z } from "zod";
import { resolveRedirect } from "~/utils/redirect";

/**
 * Sign-in, and first-run setup on an install that has no accounts yet.
 *
 * Which of the two it shows comes from GET /api/setup, the one public endpoint
 * that answers "does this server have anybody on it". Both live on one page so
 * a fresh install has a single place to land.
 */

definePage({ meta: { layout: false } });

useHead({ title: "Sign in" });

const router = useRouter();
const route = useRoute();
const { login, isAuthenticated } = useAuth();
const { mutateAsync: runSetup } = useSetup();
const client = useApiClient();

const setupRequired = ref(false);
const loading = ref(false);
const errorMessage = ref<string | null>(null);

const { data: setupStatus } = useQuery({
  key: ["setup-status"],
  query: async () => {
    const res = await client.api.setup.$get();
    if (!res.ok) throw new Error("Could not reach the server");
    return res.json();
  },
  staleTime: 0,
});

watch(
  setupStatus,
  (status) => {
    if (status) setupRequired.value = status.required;
  },
  { immediate: true },
);

const loginSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});
const setupSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.email("Enter a valid email address"),
  password: z.string().min(8, "At least 8 characters").max(128),
});

const loginState = reactive({ email: "", password: "" });
const setupState = reactive({ name: "", email: "", password: "" });

/** Where the guard wanted to go before it sent us here. */
function intendedDestination(): string {
  return resolveRedirect(route.query.redirect);
}

async function handleLogin() {
  loading.value = true;
  errorMessage.value = null;
  try {
    await login(loginState.email, loginState.password);
    await router.replace(intendedDestination());
  } catch (err: unknown) {
    // Deliberately generic, and identical whether the address is unknown or the
    // password is wrong: distinguishing them turns this form into a way to test
    // whether somebody has an account here.
    const message = err instanceof Error ? err.message : "";
    errorMessage.value = /network/i.test(message)
      ? "Could not reach the server. Please try again."
      : /too many/i.test(message)
        ? message
        : "Invalid email or password.";
  } finally {
    loading.value = false;
    loginState.password = "";
  }
}

async function handleSetup() {
  loading.value = true;
  errorMessage.value = null;
  try {
    await runSetup({ ...setupState });
    // Setup creates the account; sign in with the credentials just chosen so
    // the admin lands inside rather than at a second form.
    await login(setupState.email, setupState.password);
    await router.replace(intendedDestination());
  } catch {
    errorMessage.value = "Could not create the admin account. Please try again.";
  } finally {
    loading.value = false;
    setupState.password = "";
  }
}

// Someone with a live session has no business on this page.
watchEffect(() => {
  if (isAuthenticated.value) void router.replace(intendedDestination());
});
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-default px-4">
    <div class="w-full max-w-sm space-y-6" data-testid="login-page">
      <div class="text-center space-y-2">
        <UIcon name="i-lucide-library-big" class="text-4xl text-primary" />
        <h1 class="text-xl font-semibold text-highlighted">
          {{ setupRequired ? "Welcome to Libris" : "Sign in to Libris" }}
        </h1>
        <p v-if="setupRequired" class="text-sm text-muted" data-testid="setup-intro">
          No accounts exist yet. Create the first admin to get started.
        </p>
      </div>

      <UAlert
        v-if="errorMessage"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="errorMessage"
        data-testid="login-error"
      />

      <!-- First-run setup -->
      <UForm
        v-if="setupRequired"
        :schema="setupSchema"
        :state="setupState"
        class="space-y-4"
        @submit="handleSetup"
      >
        <UFormField name="name" label="Your name">
          <UInput
            v-model="setupState.name"
            placeholder="e.g. Alex"
            class="w-full"
            data-testid="setup-name-input"
          />
        </UFormField>
        <UFormField name="email" label="Email">
          <UInput
            v-model="setupState.email"
            type="email"
            autocomplete="username"
            placeholder="you@example.com"
            class="w-full"
            data-testid="setup-email-input"
          />
        </UFormField>
        <UFormField name="password" label="Password" hint="At least 8 characters">
          <UInput
            v-model="setupState.password"
            type="password"
            autocomplete="new-password"
            class="w-full"
            data-testid="setup-password-input"
          />
        </UFormField>
        <UButton
          type="submit"
          label="Create admin account"
          color="primary"
          block
          :loading="loading"
          data-testid="setup-submit-btn"
        />
      </UForm>

      <!-- Sign in -->
      <UForm
        v-else
        :schema="loginSchema"
        :state="loginState"
        class="space-y-4"
        @submit="handleLogin"
      >
        <UFormField name="email" label="Email">
          <UInput
            v-model="loginState.email"
            type="email"
            autocomplete="username"
            placeholder="you@example.com"
            class="w-full"
            data-testid="login-email-input"
          />
        </UFormField>
        <UFormField name="password" label="Password">
          <UInput
            v-model="loginState.password"
            type="password"
            autocomplete="current-password"
            class="w-full"
            data-testid="login-password-input"
          />
        </UFormField>
        <UButton
          type="submit"
          label="Sign in"
          color="primary"
          block
          :loading="loading"
          data-testid="login-submit-btn"
        />
        <!-- No forgot-password link: there is no mail transport yet
             (libris-2ld), so a link would lead nowhere. -->
        <p class="text-xs text-muted text-center" data-testid="password-reset-note">
          Forgotten your password? An admin can reset it for you.
        </p>
      </UForm>
    </div>
  </div>
</template>
