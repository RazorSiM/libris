<template>
  <main
    class="relative grid min-h-dvh place-items-center overflow-hidden bg-default px-4 py-10 sm:px-6"
    data-testid="auth-layout"
  >
    <div
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,var(--ui-bg-elevated),transparent_55%)] opacity-70"
      aria-hidden="true"
    />
    <div class="relative w-full max-w-sm">
      <slot />
    </div>
  </main>
</template>
