import { defineConfig } from "vitepress";
import { generateSidebar } from "vitepress-sidebar";
import { useSidebar } from "vitepress-openapi";
import { spec } from "./openapi";

const openApiSidebar = useSidebar({ spec });

export default defineConfig({
  title: "Libris",
  description: "Self-hosted book management system",

  ignoreDeadLinks: [/^http:\/\/localhost/],

  vite: {
    build: {
      rollupOptions: {
        external: [/^vscode-/, /^langium/],
      },
    },
    optimizeDeps: {
      include: ["vitepress-mermaid-renderer > mermaid > dayjs"],
    },
    ssr: {
      noExternal: ["vitepress-openapi"],
    },
  },

  themeConfig: {
    sidebar: {
      "/api/": [
        {
          text: "API Reference",
          link: "/api/",
          items: openApiSidebar.generateSidebarGroups({ linkPrefix: "/api/" }),
        },
      ],
      "/": generateSidebar({
        documentRootPath: "/",
        useTitleFromFileHeading: true,
        useTitleFromFrontmatter: true,
        useFolderTitleFromIndexFile: true,
        useFolderLinkFromIndexFile: true,
        collapsed: false,
        collapseDepth: 2,
        excludeByGlobPattern: ["images/**", "README.md", "CHANGELOG.md", "scripts/**", "api/**"],
        sortMenusByFrontmatterOrder: true,
        includeFolderIndexFile: true,
      }) as any,
    },

    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Architecture", link: "/architecture" },
      { text: "API", link: "/api/" },
      { text: "Deployment", link: "/deployment" },
      { text: "Changelog", link: "/changelog/" },
    ],

    search: {
      provider: "local",
    },

    outline: {
      level: [2, 3],
    },
  },
});
