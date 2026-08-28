import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /*
     * Test FILES run one at a time.
     *
     * Several suites drive real git against real temp directories, and
     * `shallowClone` names every checkout `ayos-*` under the OS temp dir. One
     * of them asserts that a failed clone leaves nothing behind — which it
     * cannot do honestly while another file's job is mid-clone next to it. The
     * whole suite takes seconds; the flake it removes is worth more than the
     * parallelism it costs.
     */
    fileParallelism: false,
  },
});
