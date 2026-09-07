import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
  testDir:'./tests',maxFailures:1,fullyParallel:false,workers:1,retries:0,timeout:150_000,
  expect:{timeout:30_000},
  reporter:[['list'],['html',{open:'never'}],['json',{outputFile:'test-results/results.json'}]],
  use:{baseURL:'http://127.0.0.1:4173/worldgraph/',trace:'retain-on-failure',screenshot:'only-on-failure',
    // CI exercises actual WebGL2 through ANGLE/SwiftShader. This is not a physical GPU benchmark.
    launchOptions:{args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}},
  projects:[{name:'desktop-chromium',use:{viewport:{width:1440,height:1000}}},{name:'mobile-chromium',use:{...devices['Pixel 7'],deviceScaleFactor:1,defaultBrowserType:'chromium'}}],
  webServer:{command:'npm run preview -- --host 127.0.0.1',url:'http://127.0.0.1:4173/worldgraph/',reuseExistingServer:false,timeout:30_000},
});
