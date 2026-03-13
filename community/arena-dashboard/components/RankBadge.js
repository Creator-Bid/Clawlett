export default function RankBadge({ rank }) {
  if (rank === 1) {
    return (
      <div className="flex items-center justify-center w-7 h-7 rounded-full font-bold text-xs text-black bg-gradient-to-br from-yellow-300 to-amber-500 shadow-card-gold">
        1
      </div>
    );
  }
  if (rank === 2) {
    return (
      <div className="flex items-center justify-center w-7 h-7 rounded-full font-bold text-xs text-black bg-gradient-to-br from-gray-200 to-gray-400 shadow-card-silver">
        2
      </div>
    );
  }
  if (rank === 3) {
    return (
      <div className="flex items-center justify-center w-7 h-7 rounded-full font-bold text-xs text-black bg-gradient-to-br from-orange-300 to-orange-600 shadow-card-bronze">
        3
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center w-7 h-7 rounded-full font-bold text-xs text-gray-400 bg-arena-700 border border-arena-500/30">
      {rank}
    </div>
  );
}
