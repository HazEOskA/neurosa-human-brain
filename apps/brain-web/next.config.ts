import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@neurosa/brain-visualization"],
};

export default config;
