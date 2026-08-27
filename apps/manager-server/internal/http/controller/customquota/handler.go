package customquota

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/middleware"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	customquotasvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/customquota"
)

const maxCustomQuotaQueryBodyBytes int64 = 64 * 1024

type Handler struct {
	App *app.Context
}

func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	if !middleware.AuthorizePanel(w, r, h.App.AdminAuthService) {
		return
	}
	if r.Method != http.MethodPost {
		response.MethodNotAllowed(w)
		return
	}
	var req customquotasvc.QueryRequest
	body := http.MaxBytesReader(w, r.Body, maxCustomQuotaQueryBodyBytes)
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, err)
		return
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			err = errors.New("request body must contain a single JSON object")
		}
		response.Error(w, http.StatusBadRequest, err)
		return
	}
	result, err := h.App.CustomQuotaService.Query(r.Context(), req)
	if err != nil {
		response.Error(w, customquotasvc.ErrorStatus(err), err)
		return
	}
	response.JSON(w, http.StatusOK, result)
}
