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
import { flushPromises, mount } from "@vue/test-utils";
import type { ManagedUser } from "~/composables/mutations/useUserMutations";

const users = ref<ManagedUser[]>([]);
const { updateUser, refreshSession } = vi.hoisted(() => ({
  updateUser: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock("~/composables/mutations/useUserMutations", () => ({
  useUpdateUser: () => ({ mutateAsync: updateUser, isLoading: ref(false) }),
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
  useAuth: () => ({ userId: ref("current-user"), refresh: refreshSession }),
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
  // Emits submit on a native submit, skipping schema validation: what is under
  // test is what the component sends, not @nuxt/ui's validator.
  UForm: {
    emits: ["submit"],
    template: `<form v-bind="$attrs" @submit.prevent="$emit('submit')"><slot /></form>`,
  },
  UFormField: { template: `<div><slot /></div>` },
  UIcon: { template: `<span />` },
  UInput: {
    props: ["modelValue"],
    emits: ["update:modelValue"],
    inheritAttrs: false,
    template: `<input v-bind="$attrs" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
  },
  UModal: {
    props: ["open"],
    template: `<div v-if="open"><slot name="body" /><slot name="footer" /></div>`,
  },
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

describe("SettingsUsers editing a user", () => {
  const migrated: ManagedUser = {
    id: "migrated",
    email: "bdb17663-5f13-4f8f-8b1d-880b9e9c4eaa@migrated.invalid",
    name: "Alb",
    role: "user",
    createdAt: new Date(),
  };
  const self: ManagedUser = {
    id: "current-user",
    email: "me@example.test",
    name: "Me",
    role: "admin",
    createdAt: new Date(),
  };

  it("flags a migrated placeholder address, and only that", () => {
    const wrapper = render([migrated, self]);

    expect(wrapper.find('[data-testid="placeholder-email-badge-migrated"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="placeholder-email-badge-current-user"]').exists()).toBe(
      false,
    );
  });

  it("opens with the name filled in and a placeholder address cleared", async () => {
    const wrapper = render([migrated]);

    await wrapper.get('[data-testid="edit-user-btn-migrated"]').trigger("click");

    const name = wrapper.get('[data-testid="edit-user-name"]').element as HTMLInputElement;
    const email = wrapper.get('[data-testid="edit-user-email"]').element as HTMLInputElement;
    expect(name.value).toBe("Alb");
    expect(email.value).toBe("");
  });

  it("sends only name and email, and closes on success", async () => {
    updateUser.mockReset().mockResolvedValue({});
    refreshSession.mockReset();
    const wrapper = render([migrated]);

    await wrapper.get('[data-testid="edit-user-btn-migrated"]').trigger("click");
    await wrapper.get('[data-testid="edit-user-name"]').setValue("  Alberto  ");
    await wrapper.get('[data-testid="edit-user-email"]').setValue("alb@example.test");
    await wrapper.get('[data-testid="edit-user-form"]').trigger("submit");
    await flushPromises();

    expect(updateUser).toHaveBeenCalledWith({
      userId: "migrated",
      name: "Alberto",
      email: "alb@example.test",
    });
    expect(wrapper.find('[data-testid="edit-user-form"]').exists()).toBe(false);
    // Somebody else's row: your own session did not change.
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("offers Edit on your own row and re-reads your session after saving", async () => {
    updateUser.mockReset().mockResolvedValue({});
    refreshSession.mockReset();
    const wrapper = render([self]);

    const button = wrapper.get('[data-testid="edit-user-btn-current-user"]');
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click");
    expect((wrapper.get('[data-testid="edit-user-email"]').element as HTMLInputElement).value).toBe(
      "me@example.test",
    );
    await wrapper.get('[data-testid="edit-user-email"]').setValue("new-me@example.test");
    await wrapper.get('[data-testid="edit-user-form"]').trigger("submit");
    await flushPromises();

    expect(updateUser).toHaveBeenCalledWith({
      userId: "current-user",
      name: "Me",
      email: "new-me@example.test",
    });
    expect(refreshSession).toHaveBeenCalledOnce();
  });

  it("keeps the dialog open when the server refuses", async () => {
    updateUser.mockReset().mockRejectedValue(new Error("User already exists. Use another email."));
    const wrapper = render([migrated]);

    await wrapper.get('[data-testid="edit-user-btn-migrated"]').trigger("click");
    await wrapper.get('[data-testid="edit-user-email"]').setValue("taken@example.test");
    await wrapper.get('[data-testid="edit-user-form"]').trigger("submit");
    await flushPromises();

    expect(wrapper.find('[data-testid="edit-user-form"]').exists()).toBe(true);
  });
});
