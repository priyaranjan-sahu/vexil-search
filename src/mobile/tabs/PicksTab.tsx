import { useSearchStore } from "../../store/searchStore";
import type { SearchResult } from "../../store/searchStore";
import { ResultCard } from "../components/ResultCard";

export const PicksTab = ({
  onLongPress,
}: {
  onLongPress: (result: SearchResult) => void;
}) => {
  const myPicks = useSearchStore((s) => s.myPicks);
  const openResult = useSearchStore((s) => s.openResult);

  return (
    <section className="mob-tab-content">
      <div className="mob-tab-title">My Picks</div>
      <div className="mob-scroll">
        {myPicks.length > 0 ? (
          <ul className="mob-list">
            {myPicks.map((pick) => (
              <ResultCard
                key={pick.id}
                result={pick}
                isPinned
                onOpen={() => void openResult(pick)}
                onLongPress={onLongPress}
              />
            ))}
          </ul>
        ) : (
          <div className="mob-empty">
            Long-press a file in Search and choose "Pin to My Picks"
          </div>
        )}
      </div>
    </section>
  );
};
