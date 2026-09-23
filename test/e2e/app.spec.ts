import { expect, browser, $ } from "@wdio/globals";

describe("Vexil App E2E", () => {
  it("should launch the application and display the search bar", async () => {
    // Wait for the app to load
    await browser.pause(2000);

    // Verify the main search input exists
    const searchInput = await $('input[type="text"]');
    await expect(searchInput).toExist();

    // Verify filter buttons exist
    const folderFilter = await $("button=Folders");
    await expect(folderFilter).toExist();
  });
});
