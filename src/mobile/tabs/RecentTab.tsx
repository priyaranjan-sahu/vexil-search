import { useSearchStore } from "../../store/searchStore";
import type { SearchResult } from "../../store/searchStore";
import { ResultCard } from "../components/ResultCard";

export const RecentTab = ({
  onLongPress,
}: {
  onLongPress: (result: SearchResult) => void;
}) => {
  const recentItems = useSearchStore((s) => s.recentItems);
  const openResult = useSearchStore((s) => s.openResult);

  return (
    <section className="mob-tab-content">
      <div className="mob-tab-title">Recent</div>
      <div className="mob-scroll">
        {recentItems.length > 0 ? (
          <ul className="mob-list">
            {recentItems.map((recent) => (
              <ResultCard
                key={`recent-${recent.id}-${recent.path}`}
                result={recent}
                isPinned={false}
                onOpen={() => void openResult(recent)}
                onLongPress={onLongPress}
              />
            ))}
          </ul>
        ) : (
          <div className="mob-empty">Opened files will appear here</div>
        )}
      </div>
    </section>
  );
};
