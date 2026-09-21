// @vitest-environment happy-dom
/**
 * Role badges and labels follow role *membership*.
 *
 * Better Auth stores multiple roles comma-joined (`"admin,user"`). The toggle
 * action already used `roleHasAdmin`, but the Admin badge and the button label
 * compared with `=== "admin"`, so a multi-role admin rendered as a plain user
 * behind a "Make admin" button that actually demoted them.
 *
 * @nuxt/ui is not registered in the test build (see vite.config.ts), so its
 * components are stubbed by hand — UButton renders its `label` so the toggle
 * text can be asserted.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { computed, reactive, ref } from "vue";
import { mount } from "@vue/test-utils";
import type { ManagedUser } from "~/composables/mutations/useUserMutations";

const users = ref<ManagedUser[]>([]);

vi.mock("~/composables/mutations/useUserMutations", () => ({
  useUsersQuery: () => ({ data: users, status: ref("success") }),
  useCreateUser: () => ({ mutateAsync: vi.fn(), isLoading: ref(false) }),
  useSetUserRole: () => ({ mutateAsync: vi.fn() }),
  useBanUser: () => ({ mutateAsync: vi.fn() }),
  useSetUserPassword: () => ({ mutateAsync: vi.fn(), isLoading: ref(false) }),
}));

// What Nuxt/vite auto-imports normally inject into SFC scope. `useAuth` is not
// imported by the component, so the shim has to sit on `globalThis`.
Object.assign(globalThis, {
  ref,
  computed,
  reactive,
  useAuth: () => ({ userId: ref("current-user"), refresh: vi.fn() }),
  useToast: () => ({ add: vi.fn() }),
});

const SettingsUsers = (await import("./SettingsUsers.vue")).default;

const stubs = {
  UButton: {
    props: ["label", "disabled"],
    inheritAttrs: false,
    template: `<button :disabled="disabled" v-bind="$attrs">{{ label }}<slot /></button>`,
  },
  UBadge: { template: `<span class="u-badge" v-bind="$attrs"><slot /></span>` },
  UCard: { template: `<div><slot /></div>` },
  UForm: { template: `<form><slot /></form>` },
  UFormField: { template: `<div><slot /></div>` },
  UIcon: { template: `<span />` },
  UInput: { template: `<input />` },
  UModal: { template: `<div><slot name="body" /><slot name="footer" /></div>` },
  USelect: { template: `<select />` },
  USkeleton: { template: `<div />` },
};

function render(seeded: ManagedUser[]) {
  users.value = seeded;
  return mount(SettingsUsers, { global: { stubs } });
}

describe("SettingsUsers role display", () => {
  it("shows an admin,user account as an admin with a demote action", () => {
    const wrapper = render([
      {
        id: "multi",
        email: "multi@example.test",
        name: "Multi",
        role: "admin,user",
        createdAt: new Date(),
      },
    ]);

    expect(wrapper.find('[data-testid="role-badge-admin"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="toggle-role-btn-multi"]').text()).toBe("Make user");
  });

  it("keeps a plain role user without the badge and offering promotion", () => {
    const wrapper = render([
      {
        id: "plain",
        email: "plain@example.test",
        name: "Plain",
        role: "user",
        createdAt: new Date(),
      },
    ]);

    expect(wrapper.find('[data-testid="role-badge-admin"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="toggle-role-btn-plain"]').text()).toBe("Make admin");
  });
});
