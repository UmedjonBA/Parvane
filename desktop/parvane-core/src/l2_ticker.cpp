// Parvane fork: см. l2_ticker.h.
#include "parvane/l2_ticker.h"

namespace parvane::v2 {

bool L2Ticker::isTicked(const std::string &method) {
    // Доставка записей; сигналы звонка — сразу
    return method == "msg.deliver_sealed" || method == "msg.deliver_group";
}

L2Ticker::L2Ticker(Deps deps) : deps_(std::move(deps)) {}

L2Ticker::~L2Ticker() { stop(); }

std::int64_t L2Ticker::nextDelay() {
    std::uniform_real_distribution<double> d(-1.0, 1.0);
    std::lock_guard<std::mutex> lk(mu_);
    return std::max<std::int64_t>(1, deps_.tickMs + static_cast<std::int64_t>(d(rng_) * static_cast<double>(deps_.jitterMs)));
}

void L2Ticker::sendItem(const std::shared_ptr<Item> &item) {
    try {
        item->result = deps_.send(item->method, item->body, item->dest);
    } catch (...) {
        item->error = std::current_exception();
    }
    {
        std::lock_guard<std::mutex> lk(mu_);
        item->done = true;
    }
    cv_.notify_all();
}

std::string L2Ticker::submit(const std::string &method, const std::string &body, const std::string &dest) {
    if (!isTicked(method) || !deps_.isActive || !deps_.isActive()) return deps_.send(method, body, dest);
    auto item = std::make_shared<Item>();
    item->method = method;
    item->body = body;
    item->dest = dest;
    {
        std::lock_guard<std::mutex> lk(mu_);
        queue_.push_back(item);
    }
    wakeCv_.notify_all();
    std::unique_lock<std::mutex> lk(mu_);
    cv_.wait(lk, [&] { return item->done; });
    if (item->error) std::rethrow_exception(item->error);
    return item->result;
}

void L2Ticker::tick() {
    if (!deps_.isActive || !deps_.isActive()) {
        // Режим выключили — накопленное уходит сразу, шума больше нет
        std::deque<std::shared_ptr<Item>> all;
        {
            std::lock_guard<std::mutex> lk(mu_);
            all.swap(queue_);
        }
        for (const auto &item : all) sendItem(item);
        return;
    }
    std::shared_ptr<Item> item;
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (!queue_.empty()) {
            item = queue_.front();
            queue_.pop_front();
        }
    }
    if (item) {
        sendItem(item);
        return;
    }
    const auto cover = deps_.makeCover ? deps_.makeCover() : std::nullopt;
    if (!cover) return;
    ++covers_;
    try {
        (void)deps_.send(cover->first, cover->second, std::string());
    } catch (const std::exception &e) {
        if (deps_.log) deps_.log(std::string("L2: пустышка не ушла: ") + e.what());
    }
}

void L2Ticker::start() {
    if (thread_.joinable()) return;
    stopping_ = false;
    thread_ = std::thread([this] {
        while (!stopping_) {
            const bool active = deps_.isActive && deps_.isActive();
            {
                std::unique_lock<std::mutex> lk(mu_);
                if (!active && queue_.empty()) {
                    // Режима нет — ждём, пока его включат (refresh) или придёт запись
                    wakeCv_.wait(lk, [&] { return stopping_.load() || !queue_.empty() || (deps_.isActive && deps_.isActive()); });
                    if (stopping_) return;
                }
            }
            if (deps_.isActive && deps_.isActive()) {
                const auto delay = nextDelay();
                std::unique_lock<std::mutex> lk(mu_);
                wakeCv_.wait_for(lk, std::chrono::milliseconds(delay), [&] { return stopping_.load(); });
                if (stopping_) return;
            }
            tick();
        }
    });
}

void L2Ticker::refresh() {
    { std::lock_guard<std::mutex> lk(mu_); } // не терять пробуждение между проверкой предиката и ожиданием
    wakeCv_.notify_all();
}

void L2Ticker::stop() {
    stopping_ = true;
    wakeCv_.notify_all();
    if (thread_.joinable()) thread_.join();
    std::deque<std::shared_ptr<Item>> all;
    {
        std::lock_guard<std::mutex> lk(mu_);
        all.swap(queue_);
    }
    for (const auto &item : all) sendItem(item);
}

std::size_t L2Ticker::pending() {
    std::lock_guard<std::mutex> lk(mu_);
    return queue_.size();
}

} // namespace parvane::v2
