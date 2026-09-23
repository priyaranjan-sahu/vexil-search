import { useSearchStore } from "../store/searchStore";

export const MenuBar = () => {
  const activeMenu = useSearchStore((state) => state.activeMenu);
  const setActiveMenu = useSearchStore((state) => state.setActiveMenu);
  const setShowSettings = useSearchStore((state) => state.setShowSettings);
  const setShowAbout = useSearchStore((state) => state.setShowAbout);

  return (
    <div className="menu-bar">
      <div
        className="menu-item-container"
        onMouseLeave={() => setActiveMenu("")}
      >
        <div
          className="menu-item"
          onMouseEnter={() => setActiveMenu("File")}
          onClick={() => setActiveMenu("File")}
        >
          File
        </div>
        {activeMenu === "File" && (
          <div className="menu-dropdown">
            <div className="menu-dropdown-item">
              New Search <span style={{ opacity: 0.5 }}>Ctrl+N</span>
            </div>
            <div className="menu-dropdown-divider"></div>
            <div className="menu-dropdown-item" onClick={() => window.close()}>
              Exit
            </div>
          </div>
        )}
      </div>
      <div
        className="menu-item-container"
        onMouseLeave={() => setActiveMenu("")}
      >
        <div
          className="menu-item"
          onMouseEnter={() => setActiveMenu("Edit")}
          onClick={() => setActiveMenu("Edit")}
        >
          Edit
        </div>
        {activeMenu === "Edit" && (
          <div className="menu-dropdown">
            <div className="menu-dropdown-item">
              Copy <span style={{ opacity: 0.5 }}>Ctrl+C</span>
            </div>
            <div className="menu-dropdown-item">
              Paste <span style={{ opacity: 0.5 }}>Ctrl+V</span>
            </div>
            <div className="menu-dropdown-divider"></div>
            <div className="menu-dropdown-item">
              Select All <span style={{ opacity: 0.5 }}>Ctrl+A</span>
            </div>
          </div>
        )}
      </div>
      <div
        className="menu-item-container"
        onMouseLeave={() => setActiveMenu("")}
      >
        <div
          className="menu-item"
          onMouseEnter={() => setActiveMenu("View")}
          onClick={() => setActiveMenu("View")}
        >
          View
        </div>
        {activeMenu === "View" && (
          <div className="menu-dropdown">
            <div
              className="menu-dropdown-item"
              onClick={() => setShowSettings(true)}
            >
              Theme Settings
            </div>
          </div>
        )}
      </div>
      <div
        className="menu-item-container"
        onMouseLeave={() => setActiveMenu("")}
      >
        <div
          className="menu-item"
          onMouseEnter={() => setActiveMenu("Tools")}
          onClick={() => setActiveMenu("Tools")}
        >
          Tools
        </div>
        {activeMenu === "Tools" && (
          <div className="menu-dropdown">
            <div
              className="menu-dropdown-item"
              onClick={() => setShowSettings(true)}
            >
              Preferences...
            </div>
          </div>
        )}
      </div>
      <div
        className="menu-item-container"
        onMouseLeave={() => setActiveMenu("")}
      >
        <div
          className="menu-item"
          onMouseEnter={() => setActiveMenu("Help")}
          onClick={() => setActiveMenu("Help")}
        >
          Help
        </div>
        {activeMenu === "Help" && (
          <div className="menu-dropdown">
            <div
              className="menu-dropdown-item"
              onClick={() => {
                setShowAbout(true);
                setActiveMenu("");
              }}
            >
              About Vexil
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
